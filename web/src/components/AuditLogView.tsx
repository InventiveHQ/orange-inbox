"use client";

import { useEffect, useState } from "react";
import type { AuditAction, AuditLogRow } from "@/lib/audit";

interface MailboxOption {
  id: string;
  local_part: string;
  domain_name: string;
  display_name: string | null;
}

interface Props {
  // Mailboxes the current user is a member of — drives the picker. The API
  // re-verifies membership on every fetch so this is purely UI state.
  mailboxes: MailboxOption[];
}

// Per-mailbox audit log (#28). Picker at the top lets the viewer switch
// between mailboxes they're a member of; the table renders the most recent
// entries (server caps at 200) with who/what/when columns.
//
// Designed to drop into the Settings page as a section — see SettingsManager.
// Empty state for users with no mailbox memberships is the only fallback.
export default function AuditLogView({ mailboxes }: Props) {
  const [selected, setSelected] = useState<string | null>(mailboxes[0]?.id ?? null);
  const [entries, setEntries] = useState<AuditLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/audit?mailbox_id=${encodeURIComponent(selected)}`,
        );
        if (!res.ok) {
          if (!cancelled) {
            const b = (await res.json().catch(() => ({}))) as { error?: string };
            setError(b.error ?? `Failed (${res.status})`);
            setEntries([]);
          }
          return;
        }
        const data = (await res.json()) as { entries: AuditLogRow[] };
        if (!cancelled) setEntries(data.entries);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (mailboxes.length === 0) {
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        You aren&apos;t a member of any mailboxes yet — no audit log to show.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <div className="flex items-center gap-3 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3">
        <label className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Mailbox
        </label>
        <select
          value={selected ?? ""}
          onChange={e => setSelected(e.target.value || null)}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        >
          {mailboxes.map(mb => (
            <option key={mb.id} value={mb.id}>
              {mb.display_name?.trim() || `${mb.local_part}@${mb.domain_name}`}
            </option>
          ))}
        </select>
        {loading && <span className="text-xs text-neutral-500">Loading…</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>

      {entries.length === 0 && !loading ? (
        <p className="px-4 py-6 text-center text-sm text-neutral-500">
          No audit entries yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {entries.map(e => (
            <AuditEntryRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AuditEntryRow({ entry }: { entry: AuditLogRow }) {
  const who =
    entry.user_display_name?.trim() || entry.user_email || "Unknown user";
  const subject = entry.thread_subject?.trim() || "(no subject)";
  const when = formatAuditDate(entry.created_at);
  const payload = parsePayload(entry.payload);

  return (
    <li className="px-4 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span
        className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wider ${actionTone(
          entry.action,
        )}`}
      >
        {actionLabel(entry.action)}
      </span>
      <span className="text-sm">
        <span className="font-medium">{who}</span>
        {entry.thread_id && (
          <>
            <span className="text-neutral-500"> on </span>
            <span className="text-neutral-800 dark:text-neutral-200">
              {subject}
            </span>
          </>
        )}
        {payload && (
          <span className="ml-2 text-xs text-neutral-500 font-mono break-all">
            {payload}
          </span>
        )}
      </span>
      <span className="ml-auto shrink-0 text-xs text-neutral-500 tabular-nums">
        {when}
      </span>
    </li>
  );
}

function actionLabel(a: AuditAction): string {
  switch (a) {
    case "label_add":
      return "label +";
    case "label_remove":
      return "label −";
    case "mark_unread":
      return "mark unread";
    case "note_add":
      return "note";
    default:
      return a;
  }
}

function actionTone(a: AuditAction): string {
  // Color-code action families so the viewer can scan quickly.
  if (a === "reply") {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
  }
  if (a === "delete") {
    return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
  }
  if (a === "assign" || a === "unassign") {
    return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300";
  }
  if (a === "note_add") {
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  }
  return "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}

function parsePayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Pick a short repr — not every payload field is useful to show.
      const entries = Object.entries(parsed as Record<string, unknown>)
        .filter(([k]) => k !== "note_id")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      if (entries.length === 0) return null;
      const joined = entries.join(" ");
      return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function formatAuditDate(secs: number): string {
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameDay = now.toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
