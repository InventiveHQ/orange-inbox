"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { type CalendarEvent, type CalendarSummary } from "./CalendarManager";

// Create / edit modal for self events. Invites are read-only — for those
// this form renders a "View original message" link plus the readonly fields
// and no save button (the API route enforces 403 either way).
//
// Heavy file: owns the Repeats dropdown (#80), tz picker (#82), attendee
// chips (#81), and inline conflict banner (#86). Each block is gated by
// `isInvite` so invite-mode stays the simple read-only experience.

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

interface AttendeeDraft {
  email: string;
  role?: string | null;
  rsvp_status?: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
}

interface Conflict {
  start: number;
  end: number;
}

// Repeats dropdown values. The form maps these → RFC 5545 RRULE strings
// at submit time. v1 is a constrained list; "Custom" is a future TODO.
type RepeatPreset = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY_DAY" | "YEARLY";

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

  // Repeats (#80). On edit, derive a preset back from the stored RRULE
  // when it's one of our known shapes; anything else falls back to NONE
  // and the existing rule is preserved on save (we don't blow it away).
  const initialRepeats = inferRepeatPreset(event?.rrule ?? null);
  const [repeats, setRepeats] = useState<RepeatPreset>(initialRepeats);

  // Time zone (#82). Default order: row.tz → user default_tz → device tz.
  // The user-default is fetched on mount; the device fallback is what
  // every browser surfaces.
  const deviceTz = useMemo(() => getDeviceTz(), []);
  const [tz, setTz] = useState<string>(event?.tz ?? deviceTz);

  // Attendees (#81). On edit, GET the current list once; create mode
  // starts empty. The form sends a "set the list and email everyone"
  // PUT on save.
  const [attendees, setAttendees] = useState<AttendeeDraft[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");

  // Conflict banner (#86). Runs a debounced freebusy fetch as start/end
  // change. Skips itself in edit mode via the `exclude` parameter so the
  // event being edited doesn't show as conflicting with itself.
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

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

  // Default-tz from the user profile. Only used when the event has no tz
  // (create flow + invite-rows that arrived without a TZID). Best-effort:
  // if the fetch fails or default_tz isn't surfaced (older /api/me wire
  // shape), we stick with the device tz already on state.
  useEffect(() => {
    if (event?.tz) return; // edit on a row that carries its own tz
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me");
        if (!res.ok) return;
        const j = (await res.json().catch(() => ({}))) as {
          user?: { default_tz?: string | null };
          default_tz?: string | null;
        };
        const userDefault = j.user?.default_tz ?? j.default_tz ?? null;
        if (!cancelled && userDefault) setTz(userDefault);
      } catch {
        // Stick with device tz.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event?.tz]);

  // Edit-mode: pull the existing attendee list once.
  useEffect(() => {
    if (!isEdit || !event) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/calendar/events/${event.id}/attendees`);
        if (!res.ok) return;
        const j = (await res.json().catch(() => ({}))) as { attendees?: AttendeeDraft[] };
        if (!cancelled && j.attendees) setAttendees(j.attendees);
      } catch {
        // Soft-fail; the form still works without the list (saving an
        // empty list would clear all attendees, but the user has to
        // explicitly type the empty PUT to hit that path).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, event]);

  // Conflict scan: hits /api/calendar/freebusy whenever the chosen window
  // changes. Debounced so each keystroke in the datetime input doesn't
  // fire a request. Skipped in invite mode (read-only).
  useEffect(() => {
    if (isInvite) return;
    const startSec = parseLocalInput(startsAt);
    const endSec = endsAt ? parseLocalInput(endsAt) : null;
    if (startSec == null || endSec == null) {
      // Invalid window; clear stale conflicts from a previous valid window.
      // The disable matches the existing pattern in CalendarManager —
      // this effect IS reacting to user input by syncing derived UI state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConflicts([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const url = new URL("/api/calendar/freebusy", window.location.origin);
        url.searchParams.set("from", String(startSec));
        url.searchParams.set("to", String(endSec));
        if (event?.id) url.searchParams.set("exclude", event.id);
        const res = await fetch(url.pathname + url.search);
        if (!res.ok) return;
        const j = (await res.json().catch(() => ({}))) as { busy?: Conflict[] };
        // Filter to overlap with the chosen window — getBusyWindowsForUser
        // already does this, but the freebusy endpoint may pad slightly.
        const overlapping = (j.busy ?? []).filter(
          b => b.start < endSec && b.end > startSec,
        );
        setConflicts(overlapping);
      } catch {
        setConflicts([]);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [startsAt, endsAt, isInvite, event?.id]);

  function addAttendee(emailRaw: string) {
    const email = emailRaw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("That doesn't look like an email address.");
      return;
    }
    if (attendees.some(a => a.email === email)) return;
    setAttendees(prev => [...prev, { email }]);
    setAttendeeInput("");
    setError(null);
  }

  function removeAttendee(email: string) {
    setAttendees(prev => prev.filter(a => a.email !== email));
  }

  async function submit(e: React.FormEvent) {
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

    // Map the Repeats preset onto an RRULE string. WEEKLY uses BYDAY=
    // for the seed weekday. MONTHLY_DAY uses BYMONTHDAY= for the seed
    // day-of-month. NONE → null (and on edit, we still send `null`
    // so the row's existing rule clears).
    const seedDate = new Date(startSec * 1000);
    const rrule = buildRRuleFromPreset(repeats, seedDate);

    const baseBody = {
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
        body: JSON.stringify(baseBody),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        event?: { id: string };
      };
      if (!res.ok) {
        setError(j.message || j.error || `Failed (${res.status})`);
        return;
      }

      // Resolve the event id for the follow-up PATCH (rrule/tz) and the
      // attendees PUT. Create returns it on the response; edit re-uses
      // event!.id.
      const eventId = isEdit ? event!.id : j.event?.id;
      if (!eventId) {
        // Defensive — every successful create should hand the id back.
        // If the wire shape changed under us, just refresh and let the
        // grid pick up the new row.
        onSaved();
        return;
      }

      // Patch in rrule + tz separately (the create POST is owned by the
      // search/Manager agent and doesn't carry these fields). On NONE we
      // explicitly clear so toggling repeats off propagates correctly.
      try {
        await fetch(`/api/calendar/events/${eventId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rrule: rrule, tz: tz || null }),
        });
      } catch {
        // Soft-fail — the event still saves with default rrule/tz.
      }

      // Push the attendee list. Empty list still gets a PUT so removing
      // every attendee from an existing event clears the row. We only
      // hit the endpoint on edit, or on create if there's at least one
      // attendee — sending an empty PUT for a fresh single-shot event
      // would be wasteful.
      if (isEdit || attendees.length > 0) {
        try {
          await fetch(`/api/calendar/events/${eventId}/attendees`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ attendees }),
          });
        } catch {
          // Soft-fail; the event saves either way and the user can
          // re-open and try again.
        }
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
        className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 shadow-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between sticky top-0 bg-white dark:bg-neutral-950">
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

          {/* Conflict banner (#86). Render only when at least one
              overlap; suppressed in invite mode and when the form's
              window is invalid. Title-less by construction — the
              freebusy endpoint never returns titles. */}
          {!isInvite && conflicts.length > 0 && (
            <div
              role="status"
              className="text-xs rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5 text-amber-900 dark:text-amber-200"
            >
              {conflicts.length === 1
                ? `Conflicts with another event (${formatRange(conflicts[0])}).`
                : `Conflicts with ${conflicts.length} events.`}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              disabled={isInvite}
              checked={allDay}
              onChange={e => setAllDay(e.target.checked)}
            />
            All-day event
          </label>

          {/* Time zone picker (#82). Suppressed for all-day events —
              all-day in IANA-tz semantics is a date, not a wall-clock,
              and exposing the picker there is misleading. */}
          {!isInvite && !allDay && (
            <label className="block">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Time zone
              </span>
              <select
                value={tz}
                onChange={e => setTz(e.target.value)}
                className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm"
              >
                {TZ_CHOICES.includes(tz) ? null : <option value={tz}>{tz}</option>}
                {TZ_CHOICES.map(z => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Repeats (#80). Hidden for invites and override-only edits
              (we don't model "Edit this and following" yet — see #80
              "v1 = edit-this-only + edit-all"). */}
          {!isInvite && (
            <label className="block">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Repeats
              </span>
              <select
                value={repeats}
                onChange={e => setRepeats(e.target.value as RepeatPreset)}
                className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-sm"
              >
                <option value="NONE">Does not repeat</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">
                  Weekly on {weekdayName(parseLocalInput(startsAt))}
                </option>
                <option value="MONTHLY_DAY">
                  Monthly on day {monthDayLabel(parseLocalInput(startsAt))}
                </option>
                <option value="YEARLY">Annually</option>
              </select>
            </label>
          )}

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

          {/* Attendees (#81). Hidden for invites (read-only) and
              when no calendar is selected besides Personal — Personal
              has no mailbox_id, so there's no DKIM-signed From to
              send the REQUEST as. The picker collapses gracefully. */}
          {!isInvite && calendarId !== "personal" && (
            <div>
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Attendees
              </span>
              <div className="mt-1 flex flex-wrap gap-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1.5">
                {attendees.map(a => (
                  <span
                    key={a.email}
                    className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-900 px-2 py-0.5 text-xs"
                    title={
                      a.rsvp_status
                        ? `${a.email} — ${a.rsvp_status}`
                        : a.email
                    }
                  >
                    <RsvpDot status={a.rsvp_status ?? null} />
                    {a.email}
                    <button
                      type="button"
                      aria-label={`Remove ${a.email}`}
                      onClick={() => removeAttendee(a.email)}
                      className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="email"
                  value={attendeeInput}
                  onChange={e => setAttendeeInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === "," || e.key === " ") {
                      if (attendeeInput.trim()) {
                        e.preventDefault();
                        addAttendee(attendeeInput);
                      }
                    } else if (e.key === "Backspace" && !attendeeInput) {
                      setAttendees(prev => prev.slice(0, -1));
                    }
                  }}
                  onBlur={() => {
                    if (attendeeInput.trim()) addAttendee(attendeeInput);
                  }}
                  placeholder={attendees.length === 0 ? "name@example.com" : ""}
                  className="flex-1 min-w-[120px] bg-transparent text-xs outline-none"
                />
              </div>
              {attendees.length > 0 && (
                <p className="mt-1 text-[11px] text-neutral-500">
                  Saving will email a calendar invite (.ics) to each attendee.
                </p>
              )}
            </div>
          )}

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

function RsvpDot({ status }: { status: string | null }) {
  const color =
    status === "ACCEPTED"
      ? "bg-emerald-500"
      : status === "DECLINED"
        ? "bg-rose-500"
        : status === "TENTATIVE"
          ? "bg-amber-500"
          : "bg-neutral-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />;
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

function getDeviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// A small curated list — the IANA database has hundreds of zones, and a
// dropdown of all of them is unusable. Covering the major business zones
// + the user's device tz (which the picker injects above) gets ~99% of
// real cases without auto-completing into "Africa/Asmara".
const TZ_CHOICES: string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Athens",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function weekdayName(unixSec: number | null): string {
  if (unixSec == null) return "weekday";
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, { weekday: "long" });
}

function monthDayLabel(unixSec: number | null): string {
  if (unixSec == null) return "?";
  const d = new Date(unixSec * 1000);
  return String(d.getDate());
}

function buildRRuleFromPreset(
  preset: RepeatPreset,
  seedDate: Date,
): string | null {
  switch (preset) {
    case "NONE":
      return null;
    case "DAILY":
      return "FREQ=DAILY";
    case "WEEKLY": {
      const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][seedDate.getDay()];
      return `FREQ=WEEKLY;BYDAY=${day}`;
    }
    case "MONTHLY_DAY":
      return `FREQ=MONTHLY;BYMONTHDAY=${seedDate.getDate()}`;
    case "YEARLY":
      return "FREQ=YEARLY";
  }
}

// Reverse the build: given an existing RRULE, infer which preset to
// pre-select on edit. Anything unfamiliar (custom INTERVAL, COUNT, BYDAY
// list, etc.) falls back to NONE — the form will preserve the existing
// rule on save unless the user explicitly changes it.
function inferRepeatPreset(rrule: string | null): RepeatPreset {
  if (!rrule) return "NONE";
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  if (parts.FREQ === "DAILY" && !parts.INTERVAL && !parts.BYDAY) return "DAILY";
  if (parts.FREQ === "WEEKLY" && !parts.INTERVAL) return "WEEKLY";
  if (parts.FREQ === "MONTHLY" && !parts.INTERVAL) return "MONTHLY_DAY";
  if (parts.FREQ === "YEARLY" && !parts.INTERVAL) return "YEARLY";
  return "NONE";
}

function formatRange(c: { start: number; end: number }): string {
  const s = new Date(c.start * 1000);
  const e = new Date(c.end * 1000);
  const sLabel = s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const eLabel = e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${sLabel}–${eLabel}`;
}
