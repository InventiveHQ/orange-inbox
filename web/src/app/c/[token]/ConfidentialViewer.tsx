"use client";

import { useEffect, useRef, useState } from "react";

// Client side of the /c/<token> view. Two flows:
//   1. No passcode: body_text/body_html came down from SSR. We render
//      immediately and POST { action: "view" } to bump the view counter.
//   2. Passcode: SSR withheld the body. We render a 4-digit input, POST
//      { action: "unlock", passcode }, and swap in the returned body.
//
// Throttling: passcode attempts are throttled at the route level (per-IP
// token bucket). Locally we also rate-limit the submit button to one in-
// flight POST at a time so a stuck network doesn't fire a burst of attempts.

interface Props {
  token: string;
  requiresPasscode: boolean;
  initialBodyText: string | null;
  initialBodyHtml: string | null;
}

export default function ConfidentialViewer({
  token,
  requiresPasscode,
  initialBodyText,
  initialBodyHtml,
}: Props) {
  const [bodyText, setBodyText] = useState<string | null>(initialBodyText);
  const [bodyHtml, setBodyHtml] = useState<string | null>(initialBodyHtml);
  const [passcode, setPasscode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewPingedRef = useRef(false);

  // For the non-passcode flow, bump the view counter once on first render.
  // We avoid useEffect's strict-mode double-invoke by gating on a ref so the
  // counter increments exactly once per page load.
  useEffect(() => {
    if (requiresPasscode) return;
    if (viewPingedRef.current) return;
    viewPingedRef.current = true;
    void fetch(`/api/confidential/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "view" }),
    }).catch(() => {
      // Best-effort — the body is already rendered; a failed ping just
      // means the counter is short by one.
    });
  }, [requiresPasscode, token]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (unlocking) return;
    const cleaned = passcode.trim();
    if (!/^\d{4}$/.test(cleaned)) {
      setError("Enter the 4-digit code");
      return;
    }
    setError(null);
    setUnlocking(true);
    try {
      const res = await fetch(`/api/confidential/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlock", passcode: cleaned }),
      });
      if (res.status === 429) {
        setError("Too many attempts — try again in a minute.");
        return;
      }
      if (res.status === 410) {
        setError("This message has expired.");
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Incorrect code.");
        return;
      }
      const j = (await res.json()) as { body_text: string; body_html: string | null };
      setBodyText(j.body_text);
      setBodyHtml(j.body_html);
    } catch {
      setError("Network error — try again.");
    } finally {
      setUnlocking(false);
    }
  }

  if (bodyText != null) {
    return (
      <article className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 sm:p-6">
        {bodyHtml ? (
          // We render the sender's HTML inside an iframe to avoid leaking
          // the parent document's styles + any unintended interactions. The
          // body was authored in the orange-inbox composer (Lexical), but
          // we keep the sandbox tight — no scripts, no top-level navigation
          // — out of paranoia.
          <iframe
            srcDoc={bodyHtml}
            sandbox=""
            title="Confidential message"
            className="w-full min-h-[280px] border-0"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
            {bodyText}
          </pre>
        )}
      </article>
    );
  }

  // Passcode-gated view.
  return (
    <form
      onSubmit={unlock}
      className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 sm:p-6 space-y-3"
      noValidate
    >
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-neutral-500">
          Enter the 4-digit passcode
        </span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          pattern="\d{4}"
          value={passcode}
          onChange={e => setPasscode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus
          aria-label="4-digit passcode"
          className="mt-1 block w-full sm:w-40 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-lg tracking-[0.4em] font-mono text-center focus:outline-none focus:border-[var(--color-brand)]"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={unlocking || passcode.length < 4}
        className="rounded-md bg-[var(--color-brand)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {unlocking ? "Checking…" : "View message"}
      </button>
      <p className="text-xs text-neutral-500">
        The sender will share the code with you out-of-band (text message, in person, etc.).
      </p>
    </form>
  );
}
