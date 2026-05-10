"use client";

import { useState, useTransition } from "react";

interface Props {
  initialVips: string[];
}

// "Manage VIPs" pane (issue #73). Lives at /inbox/vips alongside the VIP
// thread list — the middle column shows incoming VIP mail, this right pane
// is the management UI. Add an address by typing it; remove with the
// trailing button. Addresses are normalised lowercase server-side, so the
// list displayed here is always already-lowered.
//
// TODO: notification overrides — VIPs should bypass DnD / mute settings.
// Hook lives in the push-notification path; for now this UI just manages
// the list and the email-worker / classifier will pick it up.
export default function VipsManager({ initialVips }: Props) {
  const [vips, setVips] = useState(initialVips);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function add() {
    const addr = input.trim().toLowerCase();
    if (!addr) return;
    if (!addr.includes("@")) {
      setError("Enter a full email address");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/vips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addr }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setVips(prev => (prev.includes(addr) ? prev : [addr, ...prev]));
      setInput("");
    });
  }

  function remove(addr: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/vips", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addr }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setVips(prev => prev.filter(a => a !== addr));
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">VIP senders</h1>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Mail from these addresses always lands in Primary, gets a star on the avatar, and
          fires notifications even when you&apos;ve muted others.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-8 space-y-6">
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <label className="block text-xs font-medium uppercase tracking-wider text-neutral-500 mb-2">
              Add a VIP
            </label>
            <div className="flex items-center gap-2">
              <input
                type="email"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="someone@example.com"
                className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
              />
              <button
                type="button"
                onClick={add}
                disabled={isPending || !input.trim()}
                className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
          </div>

          <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
            {vips.length === 0 ? (
              <div className="px-4 py-8 text-sm text-neutral-500 text-center">
                No VIPs yet. Add one above, or use &ldquo;Add to VIPs&rdquo; from any
                message&apos;s ⋯ menu.
              </div>
            ) : (
              <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {vips.map(addr => (
                  <li
                    key={addr}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="text-sm font-mono truncate">{addr}</div>
                    <button
                      type="button"
                      onClick={() => remove(addr)}
                      disabled={isPending}
                      className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
