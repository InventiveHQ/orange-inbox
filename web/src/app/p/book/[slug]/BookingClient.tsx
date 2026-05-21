"use client";

/* eslint-disable react-hooks/set-state-in-effect -- mount-time browser-API
   reads and data loads are the intended use of these effects. */

import { useCallback, useEffect, useMemo, useState } from "react";

interface Question {
  id: string;
  label: string;
  type: "text" | "textarea";
  required: boolean;
}

interface Props {
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  timezone: string;
  conferencingType: string;
  bookingWindowDays: number;
  questions: Question[];
  turnstileSiteKey: string | null;
}

interface Slot {
  start: number;
  end: number;
}

interface BookingResult {
  id: string;
  startsAt: number;
  endsAt: number;
  conferenceProvider: string | null;
  conferenceUrl: string | null;
  rescheduleToken: string;
  cancelToken: string;
}

const BRAND = "#f38020";

declare global {
  interface Window {
    __bookingTurnstileCb?: (token: string) => void;
  }
}

export default function BookingClient(props: Props) {
  const [tz, setTz] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [turnstileToken, setTurnstileToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);

  // Resolve the visitor's timezone + load availability after mount (avoids
  // an SSR/client hydration mismatch on Intl).
  useEffect(() => {
    const vtz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setTz(vtz);
    const from = Math.floor(Date.now() / 1000);
    const days = Math.min(props.bookingWindowDays || 60, 60);
    const to = from + days * 86400;
    setLoading(true);
    fetch(`/p/api/book/${props.slug}/availability?from=${from}&to=${to}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ slots: Slot[] }>;
      })
      .then((j) => setSlots(j.slots ?? []))
      .catch(() => setLoadError("Couldn't load available times. Please retry."))
      .finally(() => setLoading(false));
  }, [props.slug, props.bookingWindowDays]);

  // Load the Turnstile widget script when a site key is configured.
  useEffect(() => {
    if (!props.turnstileSiteKey) return;
    window.__bookingTurnstileCb = (token: string) => setTurnstileToken(token);
    if (document.getElementById("cf-turnstile-script")) return;
    const s = document.createElement("script");
    s.id = "cf-turnstile-script";
    s.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, [props.turnstileSiteKey]);

  // Render the Turnstile widget once we're on the form step.
  useEffect(() => {
    if (!props.turnstileSiteKey || !selected || result) return;
    const id = window.setInterval(() => {
      const w = (window as unknown as { turnstile?: {
        render: (el: string, opts: Record<string, unknown>) => void;
      } }).turnstile;
      const el = document.getElementById("cf-turnstile-box");
      if (w && el && !el.hasChildNodes()) {
        w.render("#cf-turnstile-box", {
          sitekey: props.turnstileSiteKey,
          callback: (t: string) => window.__bookingTurnstileCb?.(t),
        });
        window.clearInterval(id);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [props.turnstileSiteKey, selected, result]);

  const fmtDayKey = useCallback(
    (epoch: number) =>
      tz
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(epoch * 1000))
        : "",
    [tz],
  );
  const fmtDay = useCallback(
    (epoch: number) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz || "UTC",
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(new Date(epoch * 1000)),
    [tz],
  );
  const fmtTime = useCallback(
    (epoch: number) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz || "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(epoch * 1000)),
    [tz],
  );

  const days = useMemo(() => {
    const grouped = new Map<string, Slot[]>();
    for (const s of slots) {
      const k = fmtDayKey(s.start);
      const arr = grouped.get(k);
      if (arr) arr.push(s);
      else grouped.set(k, [s]);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [slots, fmtDayKey]);

  async function submit() {
    if (!selected) return;
    setSubmitError(null);
    if (!name.trim()) return setSubmitError("Please enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      return setSubmitError("Please enter a valid email.");
    }
    for (const q of props.questions) {
      if (q.required && !(answers[q.id] ?? "").trim()) {
        return setSubmitError(`Please answer: ${q.label}`);
      }
    }
    if (props.turnstileSiteKey && !turnstileToken) {
      return setSubmitError("Please complete the verification challenge.");
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/p/api/book/${props.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          start: selected.start,
          name: name.trim(),
          email: email.trim(),
          timezone: tz,
          answers,
          turnstileToken,
        }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; booking?: BookingResult; error?: string; message?: string }
        | null;
      if (!r.ok || !j?.ok || !j.booking) {
        setSubmitError(
          j?.message ??
            (j?.error === "slot_unavailable"
              ? "That time was just taken — please pick another."
              : "Could not complete the booking. Please try again."),
        );
        return;
      }
      setResult(j.booking);
    } catch {
      setSubmitError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- success -----------------------------------------------------------
  if (result) {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl dark:bg-green-900/30">
            ✓
          </div>
          <h1 className="mt-4 text-xl font-semibold">Booking confirmed</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {props.name}
          </p>
        </div>
        <div className="mt-5 space-y-1 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-800">
          <div className="font-medium">{fmtDay(result.startsAt)}</div>
          <div>
            {fmtTime(result.startsAt)} – {fmtTime(result.endsAt)}{" "}
            <span className="text-neutral-500">({tz})</span>
          </div>
          {result.conferenceUrl && (
            <div className="pt-1">
              {result.conferenceProvider === "google_meet" ? "Google Meet: " : "Join: "}
              <a
                href={result.conferenceUrl}
                className="text-blue-600 underline dark:text-blue-400"
              >
                {result.conferenceUrl}
              </a>
            </div>
          )}
        </div>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
          A calendar invite is on its way to{" "}
          <span className="font-medium">{email}</span>.
        </p>
        <div className="mt-4 flex gap-4 text-sm">
          <a
            className="text-blue-600 underline dark:text-blue-400"
            href={`/p/book/${props.slug}/reschedule/${result.rescheduleToken}`}
          >
            Reschedule
          </a>
          <a
            className="text-blue-600 underline dark:text-blue-400"
            href={`/p/book/${props.slug}/cancel/${result.cancelToken}`}
          >
            Cancel
          </a>
        </div>
      </Card>
    );
  }

  // ---- form --------------------------------------------------------------
  if (selected) {
    return (
      <Card>
        <button
          onClick={() => setSelected(null)}
          className="text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          ← Back to times
        </button>
        <h1 className="mt-3 text-xl font-semibold">{props.name}</h1>
        <div className="mt-1 text-sm text-neutral-500">
          {fmtDay(selected.start)} · {fmtTime(selected.start)} –{" "}
          {fmtTime(selected.end)} ({tz})
        </div>
        <div className="mt-5 space-y-4">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
              autoComplete="name"
            />
          </Field>
          <Field label="Email">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              type="email"
              autoComplete="email"
            />
          </Field>
          {props.questions.map((q) => (
            <Field
              key={q.id}
              label={q.label + (q.required ? "" : " (optional)")}
            >
              {q.type === "textarea" ? (
                <textarea
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                  }
                  className="input min-h-20"
                />
              ) : (
                <input
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                  }
                  className="input"
                />
              )}
            </Field>
          ))}
          {props.turnstileSiteKey && (
            <div id="cf-turnstile-box" className="min-h-[65px]" />
          )}
          {submitError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {submitError}
            </p>
          )}
          <button
            onClick={submit}
            disabled={submitting}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
            style={{ backgroundColor: BRAND }}
          >
            {submitting ? "Booking…" : "Confirm booking"}
          </button>
        </div>
        <style>{inputCss}</style>
      </Card>
    );
  }

  // ---- slot picker -------------------------------------------------------
  return (
    <Card>
      <h1 className="text-xl font-semibold">{props.name}</h1>
      <div className="mt-1 text-sm text-neutral-500">
        {props.durationMinutes} min
        {props.conferencingType === "google_meet" && " · Google Meet"}
        {props.conferencingType === "phone" && " · Phone call"}
        {props.conferencingType === "in_person" && " · In person"}
      </div>
      {props.description && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-400">
          {props.description}
        </p>
      )}
      <div className="mt-5">
        {loading && <p className="text-sm text-neutral-500">Loading times…</p>}
        {loadError && (
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        )}
        {!loading && !loadError && days.length === 0 && (
          <p className="text-sm text-neutral-500">
            No open times in the next while. Please check back later.
          </p>
        )}
        {!loading && days.length > 0 && (
          <>
            <p className="mb-3 text-xs text-neutral-400">
              Times shown in {tz}
            </p>
            <div className="space-y-5">
              {days.map(([key, daySlots]) => (
                <div key={key}>
                  <div className="mb-2 text-sm font-medium">
                    {fmtDay(daySlots[0].start)}
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {daySlots.map((s) => (
                      <button
                        key={s.start}
                        onClick={() => {
                          setSelected(s);
                          setSubmitError(null);
                        }}
                        className="rounded-lg border border-neutral-300 px-2 py-2 text-sm font-medium hover:border-orange-500 hover:text-orange-600 dark:border-neutral-700"
                      >
                        {fmtTime(s.start)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-900">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

const inputCss = `
.input {
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid rgb(212 212 212);
  background: transparent;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  outline: none;
}
.input:focus { border-color: ${BRAND}; }
`;
