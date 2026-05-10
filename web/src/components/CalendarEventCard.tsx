"use client";

import { useState, useTransition } from "react";

// Inline calendar invite card (#70, extended in #77). Rendered above the
// message body when `m.calendar_event` is set on a ThreadMessage. RSVP
// buttons POST /api/messages/{id}/rsvp → server composes a `text/calendar;
// method=REPLY` and sends it via env.EMAIL.send, then stamps the user's
// response on `calendar_events` (control DB) so a reload doesn't re-prompt.
//
// State priorities, top down:
//   - cancelled = 1            → "Cancelled" pill, RSVP UI hidden
//   - rsvp_status set + !sent  → pill ("Accepted" / etc.) + "Change response"
//   - rsvp_status NEEDS-ACTION → three RSVP buttons
//   - rsvp_status null         → three RSVP buttons (pre-promotion fallback)

interface Props {
  event: {
    starts_at: number;
    ends_at: number | null;
    summary: string | null;
    location: string | null;
    organizer: string | null;
    method: string | null;
    rsvp_status: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
    cancelled: number;
  };
  threadId: string;
  messageId: string;
}

type Status = "ACCEPTED" | "TENTATIVE" | "DECLINED";

export default function CalendarEventCard({ event, messageId }: Props) {
  const [pending, startTransition] = useTransition();
  // `sent` mirrors the server response when the user RSVPs from this card;
  // also seeded from the persisted `rsvp_status` so reloads carry the state.
  const initialSent: Status | null =
    event.rsvp_status === "ACCEPTED"
      ? "ACCEPTED"
      : event.rsvp_status === "TENTATIVE"
        ? "TENTATIVE"
        : event.rsvp_status === "DECLINED"
          ? "DECLINED"
          : null;
  const [sent, setSent] = useState<Status | null>(initialSent);
  // When the user wants to change a previously-sent response we collapse the
  // pill back into the three buttons. Distinct from `sent` because we still
  // want to remember the prior state if they cancel out.
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // METHOD=CANCEL on the message itself OR cancelled=1 on the persisted row
  // both surface as "this event is dead". Either path renders the badge and
  // suppresses the RSVP UI.
  const isCancellation =
    event.cancelled === 1 || (event.method ?? "").toUpperCase() === "CANCEL";

  function send(status: Status) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/messages/${messageId}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.message || body.error || `Failed (${res.status})`);
        return;
      }
      setSent(status);
      setChanging(false);
    });
  }

  return (
    <div
      className="mt-3 rounded-lg border border-sky-200 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/30 px-4 py-3"
      role="region"
      aria-label="Calendar invite"
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="shrink-0 text-2xl leading-none mt-0.5"
          title="Calendar invite"
        >
          {"📅"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold break-words">
            <span className={isCancellation ? "line-through text-neutral-500" : ""}>
              {event.summary || "(no title)"}
            </span>
            {isCancellation && (
              <span className="ml-2 align-middle inline-flex items-center rounded-full bg-rose-100 dark:bg-rose-900/40 px-2 py-0.5 text-[10px] font-medium text-rose-800 dark:text-rose-300">
                Cancelled
              </span>
            )}
          </div>
          <div
            className={`mt-1 text-xs ${isCancellation ? "line-through text-neutral-500" : "text-neutral-700 dark:text-neutral-300"}`}
          >
            {formatRange(event.starts_at, event.ends_at)}
          </div>
          {event.location && (
            <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400 break-words">
              <span aria-hidden className="mr-1">{"📍"}</span>
              {event.location}
            </div>
          )}
          {event.organizer && (
            <div className="mt-0.5 text-xs text-neutral-500 break-all">
              Organiser: {event.organizer}
            </div>
          )}

          {!isCancellation && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {sent && !changing ? (
                <>
                  <RsvpPill status={sent} />
                  <button
                    type="button"
                    onClick={() => setChanging(true)}
                    className="text-[11px] underline text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    Change response
                  </button>
                </>
              ) : (
                <>
                  <RsvpButton
                    label="Accept"
                    tone="emerald"
                    disabled={pending || !event.organizer}
                    onClick={() => send("ACCEPTED")}
                  />
                  <RsvpButton
                    label="Tentative"
                    tone="amber"
                    disabled={pending || !event.organizer}
                    onClick={() => send("TENTATIVE")}
                  />
                  <RsvpButton
                    label="Decline"
                    tone="rose"
                    disabled={pending || !event.organizer}
                    onClick={() => send("DECLINED")}
                  />
                  {sent && changing && (
                    <button
                      type="button"
                      onClick={() => setChanging(false)}
                      className="text-[11px] underline text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      Cancel
                    </button>
                  )}
                </>
              )}
              {!event.organizer && !sent && (
                <span className="text-[11px] text-neutral-500">
                  No organiser address — can&apos;t send RSVP.
                </span>
              )}
              {error && (
                <span role="alert" className="text-[11px] text-rose-700 dark:text-rose-400">
                  {error}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RsvpPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; tone: string; glyph: string }> = {
    ACCEPTED: {
      label: "Accepted",
      tone:
        "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300",
      glyph: "✓",
    },
    TENTATIVE: {
      label: "Tentative",
      tone:
        "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300",
      glyph: "?",
    },
    DECLINED: {
      label: "Declined",
      tone:
        "border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300",
      glyph: "✗",
    },
  };
  const m = map[status];
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${m.tone}`}
    >
      <span aria-hidden>{m.glyph}</span>
      <span>{m.label}</span>
    </span>
  );
}

function RsvpButton({
  label,
  tone,
  onClick,
  disabled,
}: {
  label: string;
  tone: "emerald" | "amber" | "rose";
  onClick: () => void;
  disabled: boolean;
}) {
  // Hardcoded class strings — Tailwind doesn't see dynamic concatenation,
  // so the tone enum maps to one of these blocks rather than a template.
  const cls =
    tone === "emerald"
      ? "border-emerald-300 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200"
      : tone === "amber"
        ? "border-amber-300 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-800 dark:text-amber-200"
        : "border-rose-300 dark:border-rose-800 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-800 dark:text-rose-200";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center rounded-full border bg-white dark:bg-neutral-950 px-3 py-1 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
    >
      {label}
    </button>
  );
}

// Format the start/end pair compactly. All-day events (DTSTART of date-only
// shape) come through as midnight UTC; we surface them without a time.
// Cross-day ranges fall back to a "from … to …" full-date format.
function formatRange(starts: number, ends: number | null): string {
  const s = new Date(starts * 1000);
  const allDay = isMidnight(s) && (ends == null || endsCleanly(s, new Date(ends * 1000)));

  if (allDay) {
    return `${s.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })} (all day)`;
  }

  if (ends == null) {
    return s.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const e = new Date(ends * 1000);
  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();

  if (sameDay) {
    const dateStr = s.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const t1 = s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const t2 = e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${dateStr}, ${t1} – ${t2}`;
  }

  const fmt: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return `${s.toLocaleString(undefined, fmt)} – ${e.toLocaleString(undefined, fmt)}`;
}

function isMidnight(d: Date): boolean {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0
  );
}

function endsCleanly(start: Date, end: Date): boolean {
  return isMidnight(end) && end.getTime() > start.getTime();
}
