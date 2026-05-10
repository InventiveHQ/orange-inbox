"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { type CalendarEvent, type CalendarSummary } from "./CalendarManager";

// Create / edit modal for self events. Invites are read-only — for those
// this form renders a "View original message" link plus the readonly fields
// and no save button (the API route enforces 403 either way).

interface Props {
  event: CalendarEvent | null; // null = create new
  // For new events: prefill start/end/all-day from a click on the grid.
  // Ignored when `event` is non-null (edit mode uses the row's values).
  defaults?: {
    startsAt?: number;
    endsAt?: number;
    allDay?: boolean;
  };
  // Calendars the user can post to (#78). Personal is always present;
  // mailbox calendars come from the API. Pre-existing callers (none today)
  // can pass an empty list and the dropdown collapses to Personal-only.
  calendars?: CalendarSummary[];
  // Initial value for the Calendar dropdown. "personal" (default) lands
  // events in Personal; a mailbox id places them on that mailbox's
  // calendar. Edit mode falls back to the existing row's mailbox_id.
  defaultCalendarId?: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

export default function CalendarEventForm({
  event,
  defaults,
  calendars = [],
  defaultCalendarId = "personal",
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const isEdit = event !== null;
  const isInvite = event?.source && event.source !== "self";

  const initialStartSec = event?.starts_at ?? defaults?.startsAt ?? defaultStartSeconds();
  const initialEndSec =
    event?.ends_at ?? defaults?.endsAt ?? (event ? null : initialStartSec + 3600);
  const initialAllDay = event ? event.all_day === 1 : !!defaults?.allDay;

  const [summary, setSummary] = useState(event?.summary ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [allDay, setAllDay] = useState(initialAllDay);
  // Edit mode preserves the row's calendar attribution; create mode picks
  // from the prop (typically the sidebar's current scope, defaulting to
  // Personal on the consolidated view).
  const initialCalendarId = event
    ? event.mailbox_id ?? "personal"
    : defaultCalendarId;
  const [calendarId, setCalendarId] = useState<string>(initialCalendarId);
  const [startsAt, setStartsAt] = useState<string>(toLocalInput(initialStartSec));
  const [endsAt, setEndsAt] = useState<string>(
    initialEndSec != null ? toLocalInput(initialEndSec) : "",
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLInputElement>(null);

  // Pop the cursor straight into the summary field for new events — click on
  // a slot → start typing the title is the Google flow.
  useEffect(() => {
    if (!isEdit) summaryRef.current?.focus();
  }, [isEdit]);

  // ESC to close — basic keyboard affordance; the rest is covered by the
  // backdrop click.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isInvite) return; // shouldn't fire; submit button is hidden
    setError(null);
    const startSec = parseLocalInput(startsAt);
    if (startSec === null) {
      setError("Start time is required.");
      return;
    }
    const endSec = endsAt ? parseLocalInput(endsAt) : null;
    if (endsAt && endSec === null) {
      setError("End time is invalid.");
      return;
    }
    if (endSec !== null && endSec <= startSec) {
      setError("End time must be after start time.");
      return;
    }
    if (!summary.trim()) {
      setError("Summary is required.");
      return;
    }

    const body = {
      summary: summary.trim(),
      starts_at: startSec,
      ends_at: endSec,
      all_day: allDay,
      location: location.trim() || null,
      description: description.trim() || null,
      // The API normalises "personal" → null on its end. Sending the
      // string keeps the wire format symmetric with the GET ?mailbox= path.
      mailbox_id: calendarId,
    };

    startTransition(async () => {
      const url = isEdit ? `/api/calendar/events/${event!.id}` : "/api/calendar/events";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        setError(j.message || j.error || `Failed (${res.status})`);
        return;
      }
      onSaved();
    });
  }

  function deleteEvent() {
    if (!isEdit || isInvite) return;
    if (!confirm("Delete this event?")) return;
    startTransition(async () => {
      const res = await fetch(`/api/calendar/events/${event!.id}`, { method: "DELETE" });
      const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        setError(j.message || j.error || `Failed (${res.status})`);
        return;
      }
      onDeleted();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label={isEdit ? "Edit event" : "New event"}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {isInvite ? "Invite details" : isEdit ? "Edit event" : "New event"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            <CloseIcon />
          </button>
        </div>

        <form ref={formRef} onSubmit={submit} className="px-4 py-3 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Summary
            </span>
            <input
              ref={summaryRef}
              type="text"
              required
              disabled={isInvite}
              value={summary}
              onChange={e => setSummary(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
              placeholder="What's the event?"
            />
          </label>

          {/*
            Calendar dropdown (#78). Hidden in invite mode — invite rows
            are already attributed to the mailbox they came in on, and
            the API blocks mailbox_id changes via the source != 'self'
            guard. We still surface the read-only label below to avoid
            a confusing "where did this end up?" gap.
          */}
          {!isInvite && calendars.length > 0 && (
            <label className="block">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Calendar
              </span>
              <select
                value={calendarId}
                onChange={e => setCalendarId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm"
              >
                {calendars.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Starts
              </span>
              <input
                type="datetime-local"
                required
                disabled={isInvite}
                value={startsAt}
                onChange={e => setStartsAt(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Ends
              </span>
              <input
                type="datetime-local"
                disabled={isInvite}
                value={endsAt}
                onChange={e => setEndsAt(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              disabled={isInvite}
              checked={allDay}
              onChange={e => setAllDay(e.target.checked)}
            />
            All-day event
          </label>

          <label className="block">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Location
            </span>
            <input
              type="text"
              disabled={isInvite}
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
              placeholder="Where?"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Description
            </span>
            <textarea
              disabled={isInvite}
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm disabled:opacity-60"
              placeholder="Notes for yourself."
            />
          </label>

          {isInvite && event?.source_message_id && (
            <a
              href={`/inbox/all/${event.source_message_id}`}
              className="block text-xs text-[var(--color-brand)] underline"
            >
              View original message →
            </a>
          )}

          {error && (
            <div role="alert" className="text-xs text-rose-700 dark:text-rose-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {isEdit && !isInvite && (
              <button
                type="button"
                onClick={deleteEvent}
                disabled={pending}
                className="mr-auto rounded-md px-3 py-1 text-xs text-rose-700 hover:bg-rose-100 dark:hover:bg-rose-950/40 disabled:opacity-50"
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              {isInvite ? "Close" : "Cancel"}
            </button>
            {!isInvite && (
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-[var(--color-brand)] text-white px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50"
              >
                {pending ? "Saving…" : isEdit ? "Save" : "Create"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.22 4.22a.75.75 0 0 1 1.06 0L8 6.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L9.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 1 1-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

// datetime-local input <-> unix seconds bridge. The input value is in the
// user's local timezone (no offset suffix); we round-trip through
// Date so the seconds we ship match what the user typed.
function toLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const yy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}T${h}:${m}`;
}

function parseLocalInput(s: string): number | null {
  // The datetime-local format is `YYYY-MM-DDTHH:MM` (optional seconds).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

function defaultStartSeconds(): number {
  // Round up to the next hour for a "New event" with sensible defaults.
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return Math.floor(d.getTime() / 1000);
}
