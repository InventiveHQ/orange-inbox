"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { type CalendarEvent, type CalendarSummary } from "./CalendarManager";
import {
  ALL_WEEKDAYS,
  type CustomRRuleState,
  type RRuleByday,
  buildRRule,
  formatUntilDate,
  parseRRule,
  untilToDateInput,
} from "@/lib/rrule-parse";

// Create / edit modal for self events. Invites are read-only — for those
// this form renders a "View original message" link plus the readonly fields
// and no save button (the API route enforces 403 either way).
//
// Heavy file: owns the Repeats dropdown (#80), tz picker (#82), attendee
// chips (#81), inline conflict banner (#86), reminder chips (#91),
// "edit this/and-following/all" picker (#92), and the Custom RRULE
// editor (#95). Each block is gated by `isInvite` so invite-mode stays
// the simple read-only experience.

interface Props {
  event: CalendarEvent | null; // null = create new
  // For new events: prefill start/end/all-day from a click on the grid, plus
  // optional title/location/description so callers like "add to calendar from
  // an email" can seed the form. Ignored when `event` is non-null (edit mode
  // uses the row's values).
  defaults?: {
    startsAt?: number;
    endsAt?: number;
    allDay?: boolean;
    summary?: string;
    location?: string;
    description?: string;
  };
  // Calendars the user can post to (#78). Personal is always present;
  // mailbox calendars come from the API. Pre-existing callers (none today)
  // can pass an empty list and the dropdown collapses to Personal-only.
  calendars?: CalendarSummary[];
  // Initial value for the Calendar dropdown. "personal" (default) lands
  // events in Personal; a mailbox id places them on that mailbox's
  // calendar. Edit mode falls back to the existing row's mailbox_id.
  defaultCalendarId?: string;
  // The seed start time of the specific instance being edited (#92).
  // Set this when the user clicked a single occurrence of a recurring
  // series — the "Save mode" picker will offer "this only / this and
  // following / all" and route the save accordingly. Undefined falls
  // back to the legacy whole-series PATCH path (the picker is hidden).
  // Wiring from the grid → form is a follow-up: CalendarManager is owned
  // by the grid agent and isn't passing this prop yet, so the picker
  // currently shows only when a future caller provides it.
  occurrenceStartsAt?: number;
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
// at submit time. "CUSTOM" routes through the inline rrule-parse editor;
// every other preset is a one-line emit at save.
type RepeatPreset =
  | "NONE"
  | "DAILY"
  | "WEEKLY"
  | "MONTHLY_DAY"
  | "YEARLY"
  | "CUSTOM";

// Save-mode for recurring-event edits (#92). Hidden when the event has no
// rrule. "all" = master PATCH (existing path); "this" = single override;
// "following" = split-and-rebrand the rest of the series.
type SaveScope = "this" | "following" | "all";

// Reminder chip presets (#91 spec). "Custom" prompts for an integer.
const REMINDER_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: "5 minutes before" },
  { minutes: 10, label: "10 minutes before" },
  { minutes: 15, label: "15 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 120, label: "2 hours before" },
  { minutes: 1440, label: "1 day before" },
];

// Cap on chip count — matches the API guard in [id]/reminders/route.ts.
const MAX_REMINDER_CHIPS = 5;

export default function CalendarEventForm({
  event,
  defaults,
  calendars = [],
  defaultCalendarId = "personal",
  occurrenceStartsAt,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const isEdit = event !== null;
  const isInvite = event?.source && event.source !== "self";
  const isRecurring = !!event?.rrule;
  // Show the save-mode picker only when (a) editing a recurring event and
  // (b) we know which instance the user opened. Without (b) we default to
  // whole-series semantics — that's the legacy behaviour pre-#92.
  const canSplit = isEdit && isRecurring && typeof occurrenceStartsAt === "number";

  const initialStartSec = event?.starts_at ?? defaults?.startsAt ?? defaultStartSeconds();
  const initialEndSec =
    event?.ends_at ?? defaults?.endsAt ?? (event ? null : initialStartSec + 3600);
  const initialAllDay = event ? event.all_day === 1 : !!defaults?.allDay;

  const [summary, setSummary] = useState(event?.summary ?? defaults?.summary ?? "");
  const [location, setLocation] = useState(event?.location ?? defaults?.location ?? "");
  const [description, setDescription] = useState(
    event?.description ?? defaults?.description ?? "",
  );
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

  // Repeats (#80 + #95). On edit, derive a preset back from the stored
  // RRULE when it's one of our known shapes; anything else falls back to
  // CUSTOM with the inline editor pre-populated to the parsed state, so
  // round-trip works for arbitrary RRULEs.
  const initialRepeats = inferRepeatPreset(event?.rrule ?? null);
  const [repeats, setRepeats] = useState<RepeatPreset>(initialRepeats);
  const initialCustomState = useMemo(
    () =>
      parseRRule(
        event?.rrule ?? null,
        new Date((event?.starts_at ?? initialStartSec) * 1000),
      ),
    // Run once on mount; subsequent rrule changes go through the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [customRRule, setCustomRRule] =
    useState<CustomRRuleState>(initialCustomState);

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

  // Reminders (#91). On edit, GET the current set once; create mode
  // starts empty (the row gets a default 10-minute reminder seeded by
  // createSelfEvent server-side, but the form will display whatever the
  // server returns on first edit so the user sees what's set). The PUT
  // ships on save AFTER the event row write returns ok.
  const [reminders, setReminders] = useState<number[]>([]);
  const [showReminderPicker, setShowReminderPicker] = useState(false);

  // Save-mode (#92). Defaults to "all" so the picker is a no-op when
  // hidden; rendering only flips the value when the user chooses.
  const [saveScope, setSaveScope] = useState<SaveScope>(canSplit ? "this" : "all");

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

  // Edit-mode: pull the existing reminder offsets once (#91).
  useEffect(() => {
    if (!isEdit || !event) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/calendar/events/${event.id}/reminders`);
        if (!res.ok) return;
        const j = (await res.json().catch(() => ({}))) as {
          minutes_before?: number[];
        };
        if (!cancelled && Array.isArray(j.minutes_before)) {
          setReminders(j.minutes_before);
        }
      } catch {
        // Soft-fail — the form still saves; on next open the chips will
        // populate once the network settles.
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

  function addReminder(minutes: number) {
    if (!Number.isFinite(minutes) || minutes < 0) return;
    if (minutes > 60 * 24 * 7) return; // 1 week cap mirrors the lib
    if (reminders.includes(minutes)) {
      setShowReminderPicker(false);
      return;
    }
    if (reminders.length >= MAX_REMINDER_CHIPS) {
      setError(`At most ${MAX_REMINDER_CHIPS} reminders per event.`);
      return;
    }
    setReminders(prev => [...prev, minutes].sort((a, b) => a - b));
    setShowReminderPicker(false);
    setError(null);
  }

  function removeReminder(minutes: number) {
    setReminders(prev => prev.filter(m => m !== minutes));
  }

  function promptCustomReminder() {
    const raw = window.prompt("Minutes before the event (0–10080):");
    if (raw == null) return;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 10080) {
      setError("Reminder must be between 0 and 10080 minutes.");
      return;
    }
    addReminder(n);
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
    // so the row's existing rule clears). CUSTOM serialises the inline
    // editor's state via buildRRule.
    const seedDate = new Date(startSec * 1000);
    let rrule: string | null;
    if (repeats === "CUSTOM") {
      // Validate what the editor can validate: BYDAY non-empty for
      // WEEKLY, COUNT > 0 already enforced by the input min, UNTIL
      // after start.
      if (
        customRRule.freq === "WEEKLY" &&
        customRRule.byday.length === 0
      ) {
        setError("Pick at least one weekday for the custom recurrence.");
        return;
      }
      if (customRRule.ends.kind === "until") {
        const until = customRRule.ends.until;
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(until);
        if (m) {
          const untilSec = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59) / 1000;
          if (untilSec <= startSec) {
            setError("Custom recurrence end date must be after the start.");
            return;
          }
        }
      }
      rrule = buildRRule(customRRule);
    } else {
      rrule = buildRRuleFromPreset(repeats, seedDate);
    }

    // Recurring-edit branch (#92). When the user picked "Edit this only"
    // or "Edit this and following", we route through the dedicated APIs
    // instead of the master PATCH. "all" + create both fall through to
    // the legacy path below.
    if (canSplit && saveScope !== "all" && event && typeof occurrenceStartsAt === "number") {
      startTransition(async () => {
        if (saveScope === "this") {
          // Single-instance override. Only the durable fields the override
          // table knows how to carry land here — starts/ends/summary/cancel.
          // location/description/tz/rrule changes don't fit the override
          // shape, so the form ignores them in this scope. (UX-wise, the
          // user can fall through to "Edit all" if they need those.)
          const res = await fetch(
            `/api/calendar/events/${event.id}/overrides`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                original_starts_at: occurrenceStartsAt,
                patch: {
                  starts_at: startSec,
                  ends_at: endSec,
                  summary: summary.trim(),
                },
              }),
            },
          );
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as {
              error?: string;
              message?: string;
            };
            setError(j.message || j.error || `Failed (${res.status})`);
            return;
          }
          onSaved();
          return;
        }
        // "Edit this and following" — split the series.
        const res = await fetch(`/api/calendar/events/${event.id}/split`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            occurrence_starts_at: occurrenceStartsAt,
            patch: {
              summary: summary.trim(),
              starts_at: startSec,
              ends_at: endSec,
              all_day: allDay,
              location: location.trim() || null,
              description: description.trim() || null,
              tz: tz || null,
            },
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          event_id?: string;
        };
        if (!res.ok) {
          setError(j.message || j.error || `Failed (${res.status})`);
          return;
        }
        // Mirror reminders + attendees onto the new event id when the
        // form's local state diverges from what splitRecurrenceAt copied
        // off the master. The split server-side already mirrors both,
        // but we PUT here to honour any chip churn the user did before
        // saving.
        const newId = j.event_id;
        if (newId) {
          try {
            await fetch(`/api/calendar/events/${newId}/reminders`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ minutes_before: reminders }),
            });
          } catch {
            // Soft-fail; reminders saved on master copy already mirror.
          }
          if (calendarId !== "personal" && attendees.length > 0) {
            try {
              await fetch(`/api/calendar/events/${newId}/attendees`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ attendees }),
              });
            } catch {
              // Soft-fail.
            }
          }
        }
        onSaved();
      });
      return;
    }

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

      // Push the reminder set (#91). We always fire on edit so a removed
      // chip clears the row; on create we fire only when the user
      // touched the list — leaving it alone keeps the createSelfEvent
      // server-side default (10-minute reminder) in place rather than
      // overwriting it with an empty PUT.
      if (isEdit || reminders.length > 0) {
        try {
          await fetch(`/api/calendar/events/${eventId}/reminders`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ minutes_before: reminders }),
          });
        } catch {
          // Soft-fail; the event saves either way.
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

          {/* Repeats (#80 + #95). Hidden for invites. "Custom…" reveals
              an inline editor whose state round-trips through
              parseRRule/buildRRule so saved custom shapes re-populate
              on edit. */}
          {!isInvite && (
            <div className="space-y-2">
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
                  <option value="CUSTOM">Custom…</option>
                </select>
              </label>
              {repeats === "CUSTOM" && (
                <CustomRRuleEditor
                  value={customRRule}
                  onChange={setCustomRRule}
                  startSec={parseLocalInput(startsAt)}
                />
              )}
            </div>
          )}

          {/* Save-mode picker (#92). Visible only when editing one
              instance of a recurring series. The default is "this only"
              — Google's behaviour. */}
          {canSplit && (
            <fieldset className="rounded-md border border-neutral-200 dark:border-neutral-800 px-2 py-1.5">
              <legend className="px-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Apply changes to
              </legend>
              <div className="flex flex-col gap-1 mt-1">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="save-scope"
                    value="this"
                    checked={saveScope === "this"}
                    onChange={() => setSaveScope("this")}
                  />
                  This event only
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="save-scope"
                    value="following"
                    checked={saveScope === "following"}
                    onChange={() => setSaveScope("following")}
                  />
                  This and following events
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="save-scope"
                    value="all"
                    checked={saveScope === "all"}
                    onChange={() => setSaveScope("all")}
                  />
                  All events in the series
                </label>
              </div>
            </fieldset>
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

          {/* Reminders (#91). Hidden for invites — invite-source rows
              don't carry user-side reminder rows (reminders are
              dispatched via push to the calendar owner, who is the
              meeting organizer for invite rows). The picker appears
              inline below the chips. */}
          {!isInvite && (
            <div>
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Reminders
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {reminders.map(m => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-900 px-2 py-0.5 text-xs"
                  >
                    {humanReminderLabel(m)}
                    <button
                      type="button"
                      aria-label={`Remove ${humanReminderLabel(m)} reminder`}
                      onClick={() => removeReminder(m)}
                      className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {reminders.length < MAX_REMINDER_CHIPS && (
                  <button
                    type="button"
                    onClick={() => setShowReminderPicker(s => !s)}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    + Add
                  </button>
                )}
              </div>
              {showReminderPicker && (
                <div className="mt-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-1 flex flex-wrap gap-1">
                  {REMINDER_PRESETS.map(p => (
                    <button
                      key={p.minutes}
                      type="button"
                      disabled={reminders.includes(p.minutes)}
                      onClick={() => addReminder(p.minutes)}
                      className="rounded-md px-2 py-0.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-40"
                    >
                      {p.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={promptCustomReminder}
                    className="rounded-md px-2 py-0.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    Custom…
                  </button>
                </div>
              )}
            </div>
          )}

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

// Inline editor for a custom RRULE (#95). Renders four sub-fields:
// Frequency / Interval / (BYDAY|BYMONTHDAY) / Ends. State lives in the
// parent so save can read it directly.
function CustomRRuleEditor({
  value,
  onChange,
  startSec,
}: {
  value: CustomRRuleState;
  onChange: (next: CustomRRuleState) => void;
  startSec: number | null;
}) {
  function patch(p: Partial<CustomRRuleState>) {
    onChange({ ...value, ...p });
  }

  function toggleByday(d: RRuleByday) {
    const has = value.byday.includes(d);
    const next = has
      ? value.byday.filter(x => x !== d)
      : [...value.byday, d];
    patch({ byday: next });
  }

  // The interval's noun changes per FREQ. "every 2 days" / "every 3 weeks".
  const intervalNoun =
    value.freq === "DAILY"
      ? "day"
      : value.freq === "WEEKLY"
        ? "week"
        : value.freq === "MONTHLY"
          ? "month"
          : "year";

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-2 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            Frequency
          </span>
          <select
            value={value.freq}
            onChange={e =>
              patch({
                freq: e.target.value as CustomRRuleState["freq"],
              })
            }
            className="mt-1 block w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-xs"
          >
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            Every
          </span>
          <div className="mt-1 flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={99}
              value={value.interval}
              onChange={e => {
                const n = Math.max(1, Math.min(99, Math.floor(Number(e.target.value) || 1)));
                patch({ interval: n });
              }}
              className="w-16 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1 text-xs"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              {intervalNoun}
              {value.interval === 1 ? "" : "s"}
            </span>
          </div>
        </label>
      </div>

      {value.freq === "WEEKLY" && (
        <div>
          <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
            On
          </span>
          <div className="mt-1 flex flex-wrap gap-1">
            {ALL_WEEKDAYS.map(d => {
              const checked = value.byday.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleByday(d)}
                  className={`rounded-md border px-2 py-0.5 text-xs ${
                    checked
                      ? "bg-[var(--color-brand)] text-white border-[var(--color-brand)]"
                      : "border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  }`}
                  aria-pressed={checked}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {value.freq === "MONTHLY" && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name="monthly-mode"
              checked={value.monthlyMode === "by_day"}
              onChange={() => patch({ monthlyMode: "by_day" })}
            />
            On day
            <input
              type="number"
              min={1}
              max={31}
              value={value.monthlyByMonthDay}
              onChange={e => {
                const n = Math.max(1, Math.min(31, Math.floor(Number(e.target.value) || 1)));
                patch({ monthlyByMonthDay: n, monthlyMode: "by_day" });
              }}
              className="w-14 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs"
            />
            of the month
          </label>
          <label className="flex items-center gap-2 text-xs flex-wrap">
            <input
              type="radio"
              name="monthly-mode"
              checked={value.monthlyMode === "by_weekday"}
              onChange={() => patch({ monthlyMode: "by_weekday" })}
            />
            On the
            <select
              value={String(value.monthlyByWeekdayPos)}
              onChange={e =>
                patch({
                  monthlyByWeekdayPos: Number(e.target.value),
                  monthlyMode: "by_weekday",
                })
              }
              className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs"
            >
              <option value="1">first</option>
              <option value="2">second</option>
              <option value="3">third</option>
              <option value="4">fourth</option>
              <option value="5">fifth</option>
              <option value="-1">last</option>
            </select>
            <select
              value={value.monthlyByWeekday}
              onChange={e =>
                patch({
                  monthlyByWeekday: e.target.value as RRuleByday,
                  monthlyMode: "by_weekday",
                })
              }
              className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs"
            >
              {ALL_WEEKDAYS.map(d => (
                <option key={d} value={d}>
                  {WEEKDAY_FULL[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[11px] font-medium text-neutral-700 dark:text-neutral-300">
          Ends
        </span>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="radio"
            name="ends-mode"
            checked={value.ends.kind === "never"}
            onChange={() => patch({ ends: { kind: "never" } })}
          />
          Never
        </label>
        <label className="flex items-center gap-2 text-xs flex-wrap">
          <input
            type="radio"
            name="ends-mode"
            checked={value.ends.kind === "until"}
            onChange={() =>
              patch({
                ends: {
                  kind: "until",
                  until:
                    value.ends.kind === "until"
                      ? value.ends.until
                      : formatUntilDate(
                          new Date(
                            ((startSec ?? Math.floor(Date.now() / 1000)) +
                              60 * 24 * 3600) *
                              1000,
                          )
                            .toISOString()
                            .slice(0, 10),
                        ),
                },
              })
            }
          />
          On
          <input
            type="date"
            value={
              value.ends.kind === "until" ? untilToDateInput(value.ends.until) : ""
            }
            onChange={e => {
              const formatted = formatUntilDate(e.target.value);
              if (formatted) {
                patch({ ends: { kind: "until", until: formatted } });
              }
            }}
            disabled={value.ends.kind !== "until"}
            className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs disabled:opacity-60"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="radio"
            name="ends-mode"
            checked={value.ends.kind === "count"}
            onChange={() =>
              patch({
                ends: {
                  kind: "count",
                  count: value.ends.kind === "count" ? value.ends.count : 10,
                },
              })
            }
          />
          After
          <input
            type="number"
            min={1}
            max={999}
            value={value.ends.kind === "count" ? value.ends.count : 10}
            onChange={e => {
              const n = Math.max(1, Math.min(999, Math.floor(Number(e.target.value) || 1)));
              patch({ ends: { kind: "count", count: n } });
            }}
            disabled={value.ends.kind !== "count"}
            className="w-14 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-1.5 py-0.5 text-xs disabled:opacity-60"
          />
          occurrences
        </label>
      </div>
    </div>
  );
}

const WEEKDAY_SHORT: Record<RRuleByday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const WEEKDAY_FULL: Record<RRuleByday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

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
    case "CUSTOM":
      // Caller supplies a buildRRule() string for CUSTOM — we never reach
      // here for that branch because submit() short-circuits CUSTOM
      // before calling this function.
      return null;
  }
}

// Reverse the build: given an existing RRULE, infer which preset to
// pre-select on edit. Anything unfamiliar (custom INTERVAL, COUNT, BYDAY
// list, etc.) falls back to CUSTOM so the user lands in the inline
// editor with the parsed state already filled in — round-trip then
// happens through buildRRule on save.
function inferRepeatPreset(rrule: string | null): RepeatPreset {
  if (!rrule) return "NONE";
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(";")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  // Recognise the four bare presets — a non-trivial extra (INTERVAL,
  // COUNT, UNTIL, multiple BYDAYs, BYMONTHDAY mismatch) routes to CUSTOM.
  const onlyKey = (...allowed: string[]) =>
    Object.keys(parts).every(k => allowed.includes(k));
  if (
    parts.FREQ === "DAILY" &&
    onlyKey("FREQ")
  ) {
    return "DAILY";
  }
  if (
    parts.FREQ === "WEEKLY" &&
    onlyKey("FREQ", "BYDAY") &&
    (parts.BYDAY ?? "").split(",").length === 1
  ) {
    return "WEEKLY";
  }
  if (
    parts.FREQ === "MONTHLY" &&
    onlyKey("FREQ", "BYMONTHDAY") &&
    parts.BYMONTHDAY != null
  ) {
    return "MONTHLY_DAY";
  }
  if (parts.FREQ === "YEARLY" && onlyKey("FREQ")) {
    return "YEARLY";
  }
  // Anything else → custom shape. The editor's initial state is built
  // from parseRRule on the same string, so the user sees their existing
  // rule rendered into the form instead of a "None" miss.
  return "CUSTOM";
}

function formatRange(c: { start: number; end: number }): string {
  const s = new Date(c.start * 1000);
  const e = new Date(c.end * 1000);
  const sLabel = s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const eLabel = e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${sLabel}–${eLabel}`;
}

function humanReminderLabel(m: number): string {
  if (m === 0) return "At start";
  if (m < 60) return `${m} min before`;
  if (m < 1440) {
    const h = Math.round(m / 60);
    return `${h} hour${h === 1 ? "" : "s"} before`;
  }
  const days = Math.round(m / 1440);
  return `${days} day${days === 1 ? "" : "s"} before`;
}
