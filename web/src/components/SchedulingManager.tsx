"use client";

/* eslint-disable react-hooks/set-state-in-effect -- mount-time data load is
   the intended use of this effect. */

import { useCallback, useEffect, useState } from "react";

// Scheduling admin UI (orange-inbox#101, #107, #108) — booking links,
// connected calendars, and bookings, in one page.

const BRAND = "#f38020";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CONFERENCING = [
  { value: "none", label: "No location" },
  { value: "google_meet", label: "Google Meet" },
  { value: "phone", label: "Phone call" },
  { value: "in_person", label: "In person" },
  { value: "custom_link", label: "Custom link" },
];

interface EventType {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  timezone: string;
  availability: { day: number; start: string; end: string }[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  bookingWindowDays: number;
  slotIntervalMinutes: number;
  conferencingType: string;
  conferencingConfig: { value?: string } | null;
  customQuestions: { id: string; label: string; type: string; required: boolean }[];
  active: boolean;
}
interface CalRow {
  sourceKind: string;
  orangeUserId: string | null;
  orangeMailboxId: string | null;
  calendarConnectionId: string | null;
  checkAvailability: boolean;
  writeBookings: boolean;
}
interface OrangeCal {
  mailboxId: string | null;
  label: string;
}
interface GoogleCal {
  connectionId: string;
  label: string;
  status: string;
}
interface Connection {
  id: string;
  accountEmail: string;
  status: string;
}
interface Booking {
  id: string;
  inviteeName: string;
  inviteeEmail: string;
  startsAt: number;
  status: string;
}

export default function SchedulingManager({ userId }: { userId: string }) {
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [orangeCals, setOrangeCals] = useState<OrangeCal[]>([]);
  const [googleCals, setGoogleCals] = useState<GoogleCal[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<
    { eventType: EventType | null; calendars: CalRow[] } | null
  >(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [et, cal, conn, bk] = await Promise.all([
        fetch("/api/scheduling/event-types").then((r) => r.json()) as Promise<{
          eventTypes?: EventType[];
        }>,
        fetch("/api/scheduling/calendars").then((r) => r.json()) as Promise<{
          orange?: OrangeCal[];
          google?: GoogleCal[];
          googleConfigured?: boolean;
        }>,
        fetch("/api/scheduling/connections").then((r) => r.json()) as Promise<{
          connections?: Connection[];
        }>,
        fetch("/api/scheduling/bookings?upcoming=1").then(
          (r) => r.json(),
        ) as Promise<{ bookings?: Booking[] }>,
      ]);
      setEventTypes(et.eventTypes ?? []);
      setOrangeCals(cal.orange ?? []);
      setGoogleCals(cal.google ?? []);
      setGoogleConfigured(!!cal.googleConfigured);
      setConnections(conn.connections ?? []);
      setBookings(bk.bookings ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function openEditor(id: string | null) {
    if (!id) {
      setEditing({ eventType: null, calendars: [] });
      return;
    }
    const r = await fetch(`/api/scheduling/event-types/${id}`);
    if (r.ok) {
      const j = (await r.json()) as {
        eventType: EventType;
        calendars?: CalRow[];
      };
      setEditing({ eventType: j.eventType, calendars: j.calendars ?? [] });
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this booking link? Existing bookings are kept.")) return;
    await fetch(`/api/scheduling/event-types/${id}`, { method: "DELETE" });
    reload();
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this Google calendar?")) return;
    await fetch(`/api/scheduling/connections/${id}`, { method: "DELETE" });
    reload();
  }

  if (editing) {
    return (
      <EventTypeEditor
        userId={userId}
        initial={editing.eventType}
        initialCalendars={editing.calendars}
        orangeCals={orangeCals}
        googleCals={googleCals}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <a href="/" className="text-sm text-neutral-500 hover:underline">
              ← Inbox
            </a>
            <h1 className="text-2xl font-semibold">Scheduling</h1>
            <a
              href="/inbox/help#scheduling"
              className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              How booking links work →
            </a>
          </div>
          <button
            onClick={() => openEditor(null)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: BRAND }}
          >
            New booking link
          </button>
        </div>

        {loading && <p className="text-sm text-neutral-500">Loading…</p>}

        {/* Booking links */}
        <Section title="Booking links">
          {eventTypes.length === 0 && !loading && (
            <p className="text-sm text-neutral-500">
              No booking links yet. Create one to start taking bookings.
            </p>
          )}
          <div className="space-y-2">
            {eventTypes.map((et) => (
              <div
                key={et.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{et.name}</span>
                    {!et.active && (
                      <span className="rounded bg-neutral-200 px-1.5 text-xs text-neutral-600 dark:bg-neutral-700">
                        inactive
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(
                        `${window.location.origin}/p/book/${et.slug}`,
                      );
                    }}
                    className="truncate text-xs text-blue-600 hover:underline dark:text-blue-400"
                    title="Copy public link"
                  >
                    /p/book/{et.slug} · {et.durationMinutes} min
                  </button>
                </div>
                <div className="flex shrink-0 gap-2 text-sm">
                  <a
                    href={`/p/book/${et.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-neutral-500 hover:underline"
                  >
                    Open
                  </a>
                  <button
                    onClick={() => openEditor(et.id)}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(et.id)}
                    className="text-red-600 hover:underline dark:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Calendars */}
        <Section title="Connected calendars">
          {!googleConfigured && (
            <p className="mb-2 text-sm text-amber-700 dark:text-amber-500">
              Google Calendar isn&apos;t configured on this deployment. Set
              GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to enable it. Orange Mail
              calendars work without it.
            </p>
          )}
          <div className="space-y-2">
            {connections.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <span>
                  {c.accountEmail}
                  {c.status !== "active" && (
                    <span className="ml-2 text-red-600">({c.status})</span>
                  )}
                </span>
                <button
                  onClick={() => disconnect(c.id)}
                  className="text-red-600 hover:underline dark:text-red-400"
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
          {googleConfigured && (
            <a
              href="/api/scheduling/connections/google/start"
              className="mt-2 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              + Connect a Google calendar
            </a>
          )}
        </Section>

        {/* Bookings */}
        <Section title="Upcoming bookings">
          {bookings.length === 0 && !loading && (
            <p className="text-sm text-neutral-500">No upcoming bookings.</p>
          )}
          <div className="space-y-2">
            {bookings.map((b) => (
              <div
                key={b.id}
                className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="font-medium">{b.inviteeName}</div>
                <div className="text-neutral-500">
                  {b.inviteeEmail} ·{" "}
                  {new Date(b.startsAt * 1000).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface DayState {
  enabled: boolean;
  start: string;
  end: string;
}

function EventTypeEditor({
  userId,
  initial,
  initialCalendars,
  orangeCals,
  googleCals,
  onClose,
  onSaved,
}: {
  userId: string;
  initial: EventType | null;
  initialCalendars: CalRow[];
  orangeCals: OrangeCal[];
  googleCals: GoogleCal[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const browserTz =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";

  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [duration, setDuration] = useState(initial?.durationMinutes ?? 30);
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTz);
  const [bufferBefore, setBufferBefore] = useState(
    initial?.bufferBeforeMinutes ?? 0,
  );
  const [bufferAfter, setBufferAfter] = useState(
    initial?.bufferAfterMinutes ?? 0,
  );
  const [noticeHours, setNoticeHours] = useState(
    Math.round((initial?.minNoticeMinutes ?? 0) / 60),
  );
  const [windowDays, setWindowDays] = useState(
    initial?.bookingWindowDays ?? 60,
  );
  const [slotInterval, setSlotInterval] = useState(
    initial?.slotIntervalMinutes ?? 30,
  );
  const [conferencingType, setConferencingType] = useState(
    initial?.conferencingType ?? "none",
  );
  const [confValue, setConfValue] = useState(
    initial?.conferencingConfig?.value ?? "",
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [days, setDays] = useState<DayState[]>(() => {
    const base: DayState[] = DAYS.map((_, d) => ({
      enabled: d >= 1 && d <= 5,
      start: "09:00",
      end: "17:00",
    }));
    for (const r of initial?.availability ?? []) {
      if (r.day >= 0 && r.day <= 6) {
        base[r.day] = { enabled: true, start: r.start, end: r.end };
      }
    }
    // A day present in availability but not first in loop keeps the rule;
    // days absent from availability are disabled when editing an existing one.
    if (initial) {
      const present = new Set((initial.availability ?? []).map((r) => r.day));
      for (let d = 0; d < 7; d++) base[d].enabled = present.has(d);
      for (const r of initial.availability ?? []) {
        base[r.day] = { enabled: true, start: r.start, end: r.end };
      }
    }
    return base;
  });

  const calKey = (k: string) => k;
  const [selected, setSelected] = useState<
    Record<string, { check: boolean; write: boolean }>
  >(() => {
    const m: Record<string, { check: boolean; write: boolean }> = {};
    for (const c of initialCalendars) {
      const key =
        c.sourceKind === "google"
          ? `google:${c.calendarConnectionId}`
          : `orange:${c.orangeMailboxId ?? "personal"}`;
      m[key] = { check: c.checkAvailability, write: c.writeBookings };
    }
    return m;
  });

  function toggleCal(key: string) {
    setSelected((s) => {
      const next = { ...s };
      if (next[key]) delete next[key];
      else next[key] = { check: true, write: true };
      return next;
    });
  }
  function setCalFlag(key: string, flag: "check" | "write", val: boolean) {
    setSelected((s) => ({ ...s, [key]: { ...s[key], [flag]: val } }));
  }

  const [questions, setQuestions] = useState(
    initial?.customQuestions ?? [],
  );

  async function save() {
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    const finalSlug = (slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!finalSlug) return setError("Could not derive a URL slug — set one.");

    const availability = days
      .map((d, idx) => ({ day: idx, ...d }))
      .filter((d) => d.enabled && d.start < d.end)
      .map((d) => ({ day: d.day, start: d.start, end: d.end }));
    if (availability.length === 0) {
      return setError("Set at least one available day.");
    }

    const calendars = Object.entries(selected).map(([key, flags]) => {
      if (key.startsWith("google:")) {
        return {
          sourceKind: "google",
          calendarConnectionId: key.slice("google:".length),
          checkAvailability: flags.check,
          writeBookings: flags.write,
        };
      }
      const mb = key.slice("orange:".length);
      return {
        sourceKind: "orange_native",
        orangeUserId: userId,
        orangeMailboxId: mb === "personal" ? null : mb,
        checkAvailability: flags.check,
        writeBookings: flags.write,
      };
    });
    if (calendars.length === 0) {
      return setError("Attach at least one calendar.");
    }

    const body = {
      slug: finalSlug,
      name: name.trim(),
      description: description.trim() || null,
      durationMinutes: duration,
      timezone,
      availability,
      bufferBeforeMinutes: bufferBefore,
      bufferAfterMinutes: bufferAfter,
      minNoticeMinutes: noticeHours * 60,
      bookingWindowDays: windowDays,
      slotIntervalMinutes: slotInterval,
      conferencingType,
      conferencingConfig: confValue ? { value: confValue } : null,
      customQuestions: questions,
      active,
      calendars,
    };

    setSaving(true);
    try {
      const url = initial
        ? `/api/scheduling/event-types/${initial.id}`
        : "/api/scheduling/event-types";
      const r = await fetch(url, {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(
          j?.error === "slug_taken"
            ? "That URL slug is already in use."
            : `Could not save (${j?.error ?? r.status}).`,
        );
        return;
      }
      onSaved();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 dark:bg-neutral-950">
      <div className="mx-auto max-w-2xl">
        <button
          onClick={onClose}
          className="text-sm text-neutral-500 hover:underline"
        >
          ← Back
        </button>
        <h1 className="mt-2 text-2xl font-semibold">
          {initial ? "Edit booking link" : "New booking link"}
        </h1>

        <div className="mt-5 space-y-5 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <Row label="Name">
            <input
              className="sched-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Intro call"
            />
          </Row>
          <Row label="URL slug">
            <input
              className="sched-input"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto from name"
            />
          </Row>
          <Row label="Description">
            <textarea
              className="sched-input min-h-16"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Row>
          <div className="grid grid-cols-2 gap-4">
            <Row label="Duration (min)">
              <input
                type="number"
                className="sched-input"
                value={duration}
                onChange={(e) => setDuration(+e.target.value)}
              />
            </Row>
            <Row label="Slot interval (min)">
              <input
                type="number"
                className="sched-input"
                value={slotInterval}
                onChange={(e) => setSlotInterval(+e.target.value)}
              />
            </Row>
          </div>
          <Row label="Timezone (IANA)">
            <input
              className="sched-input"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Row>

          <div>
            <div className="mb-1 text-sm font-medium">Weekly availability</div>
            <div className="space-y-1">
              {days.map((d, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <label className="flex w-20 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) =>
                        setDays((s) =>
                          s.map((x, i) =>
                            i === idx ? { ...x, enabled: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    {DAYS[idx]}
                  </label>
                  <input
                    type="time"
                    className="sched-input w-28"
                    value={d.start}
                    disabled={!d.enabled}
                    onChange={(e) =>
                      setDays((s) =>
                        s.map((x, i) =>
                          i === idx ? { ...x, start: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <span>–</span>
                  <input
                    type="time"
                    className="sched-input w-28"
                    value={d.end}
                    disabled={!d.enabled}
                    onChange={(e) =>
                      setDays((s) =>
                        s.map((x, i) =>
                          i === idx ? { ...x, end: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Row label="Buffer before (min)">
              <input
                type="number"
                className="sched-input"
                value={bufferBefore}
                onChange={(e) => setBufferBefore(+e.target.value)}
              />
            </Row>
            <Row label="Buffer after (min)">
              <input
                type="number"
                className="sched-input"
                value={bufferAfter}
                onChange={(e) => setBufferAfter(+e.target.value)}
              />
            </Row>
            <Row label="Min notice (hrs)">
              <input
                type="number"
                className="sched-input"
                value={noticeHours}
                onChange={(e) => setNoticeHours(+e.target.value)}
              />
            </Row>
          </div>
          <Row label="Booking window (days ahead)">
            <input
              type="number"
              className="sched-input"
              value={windowDays}
              onChange={(e) => setWindowDays(+e.target.value)}
            />
          </Row>

          <Row label="Location / conferencing">
            <select
              className="sched-input"
              value={conferencingType}
              onChange={(e) => setConferencingType(e.target.value)}
            >
              {CONFERENCING.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Row>
          {(conferencingType === "phone" ||
            conferencingType === "in_person" ||
            conferencingType === "custom_link") && (
            <Row
              label={
                conferencingType === "phone"
                  ? "Phone number"
                  : conferencingType === "in_person"
                    ? "Address"
                    : "Meeting link"
              }
            >
              <input
                className="sched-input"
                value={confValue}
                onChange={(e) => setConfValue(e.target.value)}
              />
            </Row>
          )}

          <div>
            <div className="mb-1 text-sm font-medium">
              Calendars (availability + where bookings are written)
            </div>
            <div className="space-y-1">
              {orangeCals.map((c) => {
                const key = `orange:${c.mailboxId ?? "personal"}`;
                return (
                  <CalRowUI
                    key={key}
                    label={c.label}
                    on={!!selected[calKey(key)]}
                    flags={selected[key]}
                    onToggle={() => toggleCal(key)}
                    onFlag={(f, v) => setCalFlag(key, f, v)}
                  />
                );
              })}
              {googleCals.map((c) => {
                const key = `google:${c.connectionId}`;
                return (
                  <CalRowUI
                    key={key}
                    label={`${c.label} (Google)`}
                    on={!!selected[key]}
                    flags={selected[key]}
                    onToggle={() => toggleCal(key)}
                    onFlag={(f, v) => setCalFlag(key, f, v)}
                  />
                );
              })}
              {orangeCals.length === 0 && googleCals.length === 0 && (
                <p className="text-sm text-neutral-500">
                  No calendars available.
                </p>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium">Intake questions</span>
              <button
                onClick={() =>
                  setQuestions((q) => [
                    ...q,
                    {
                      id: Math.random().toString(36).slice(2, 10),
                      label: "",
                      type: "text",
                      required: false,
                    },
                  ])
                }
                className="text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                + Add question
              </button>
            </div>
            {questions.map((q, i) => (
              <div key={q.id} className="mb-1 flex items-center gap-2 text-sm">
                <input
                  className="sched-input flex-1"
                  placeholder="Question"
                  value={q.label}
                  onChange={(e) =>
                    setQuestions((qs) =>
                      qs.map((x, idx) =>
                        idx === i ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) =>
                      setQuestions((qs) =>
                        qs.map((x, idx) =>
                          idx === i
                            ? { ...x, required: e.target.checked }
                            : x,
                        ),
                      )
                    }
                  />
                  req
                </label>
                <button
                  onClick={() =>
                    setQuestions((qs) => qs.filter((_, idx) => idx !== i))
                  }
                  className="text-red-600"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active (accepting bookings)
          </label>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: BRAND }}
            >
              {saving ? "Saving…" : "Save booking link"}
            </button>
          </div>
        </div>
      </div>
      <style>{`
        .sched-input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgb(212 212 212);
          background: transparent;
          padding: 0.4rem 0.6rem;
          font-size: 0.875rem;
          outline: none;
        }
        .sched-input:focus { border-color: ${BRAND}; }
        .sched-input:disabled { opacity: 0.4; }
      `}</style>
    </main>
  );
}

function Row({
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

function CalRowUI({
  label,
  on,
  flags,
  onToggle,
  onFlag,
}: {
  label: string;
  on: boolean;
  flags: { check: boolean; write: boolean } | undefined;
  onToggle: () => void;
  onFlag: (f: "check" | "write", v: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-2 text-sm dark:border-neutral-800">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={on} onChange={onToggle} />
        <span className="font-medium">{label}</span>
      </label>
      {on && flags && (
        <>
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={flags.check}
              onChange={(e) => onFlag("check", e.target.checked)}
            />
            check availability
          </label>
          <label className="flex items-center gap-1 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={flags.write}
              onChange={(e) => onFlag("write", e.target.checked)}
            />
            write bookings
          </label>
        </>
      )}
    </div>
  );
}
