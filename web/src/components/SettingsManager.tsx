"use client";

import { useMemo, useRef, useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { DomainRow } from "@/lib/queries";
import type { Identity } from "@/lib/identities";
import type { LabelRow } from "@/lib/labels";
import type { InboxLayoutRow } from "@/lib/inbox-layouts";
import type { SavedSearchRow } from "@/lib/saved-searches";
import {
  DEFAULT_PREFERENCES,
  encodePreferencesCookie,
  PREFS_COOKIE,
  type Density,
  type Theme,
  type UserPreferences,
} from "@/lib/preferences";
import type {
  DomainRow as StorageDomainRow,
  SenderRow as StorageSenderRow,
  ThreadRow as StorageThreadRow,
} from "@/lib/storage-stats";
import { formatBytes } from "@/lib/format";
import { APP_VERSION } from "@/lib/version";
import AddMailboxDialog from "./AddMailboxDialog";
import AuditLogView from "./AuditLogView";
import InboxLayoutEditor from "./InboxLayoutEditor";
import LabelChip from "./LabelChip";
import PushNotificationToggle from "./PushNotificationToggle";
import RichTextEditor from "./RichTextEditor";
import RulesEditor from "./RulesEditor";
import usePWAUpdate from "./usePWAUpdate";

interface Props {
  domains: DomainRow[];
  initialLabels: LabelRow[];
  // Mailboxes the current user can manage. For admins this is every mailbox
  // in the system; for non-admins it's empty (management UI is hidden).
  manageableIdentities: Identity[];
  // Mailboxes the current user *owns* — used for the Signatures section,
  // which is personal-config available to any owner regardless of admin status.
  ownedIdentities: Identity[];
  // Every mailbox the current user has any access role on — drives the
  // per-mailbox Audit log picker (#28). Audit log viewing is open to any
  // member of a shared mailbox, not just admins/owners.
  memberIdentities: Identity[];
  isAdmin: boolean;
  initialUndoSendSeconds: number;
  initialInboxLayouts: InboxLayoutRow[];
  savedSearches: SavedSearchRow[];
}

const PRESET_COLORS: (string | null)[] = [
  null,
  "#ef4444",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

export default function SettingsManager({
  domains,
  initialLabels,
  manageableIdentities,
  ownedIdentities,
  memberIdentities,
  isAdmin,
  initialUndoSendSeconds,
  initialInboxLayouts,
  savedSearches,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasOwnedMailboxes = ownedIdentities.length > 0;
  // Audit-log access (#28): visible to anyone with a mailbox membership.
  // Filter to mailbox-kind identities (alias identities share the parent
  // mailbox's audit trail, so we don't duplicate them in the picker).
  const auditMailboxes = useMemo(
    () => memberIdentities.filter(i => i.kind === "mailbox"),
    [memberIdentities],
  );
  const hasAuditAccess = auditMailboxes.length > 0;

  // Search/filter (live): each section is wrapped in a data-settings-
  // section div, and after every keystroke we walk those wrappers and
  // hide ones whose textContent doesn't include the query. Cheap because
  // the whole page is ~20 sections of static prose + form labels — the
  // cost is dominated by the textContent reads, not the loop. Hidden
  // sections keep their <section id="…"> intact so the drawer's
  // scrollIntoView still finds them (the user can clear the search to
  // see the result move into view).
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState<number | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    const wrappers = root.querySelectorAll<HTMLElement>("[data-settings-section]");
    let visible = 0;
    for (const w of wrappers) {
      const text = (w.textContent ?? "").toLowerCase();
      const match = q === "" || text.includes(q);
      if (match) {
        w.removeAttribute("hidden");
        visible++;
      } else {
        w.setAttribute("hidden", "");
      }
    }
    setMatchCount(q === "" ? null : visible);
  }, [query]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Settings</h1>
        <div className="ml-auto flex items-center gap-2">
          {matchCount !== null && (
            <span className="text-xs text-neutral-500">
              {matchCount === 0 ? "No matches" : `${matchCount} section${matchCount === 1 ? "" : "s"}`}
            </span>
          )}
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm px-2 py-1 w-48 sm:w-64 focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/40"
          />
        </div>
      </header>
      {/* Section anchor list lives in the global Sidebar's section
          drawer (SettingsSidebarBody) — clicking an entry there
          scrolls these anchors via document.getElementById + ScrollIntoView. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 space-y-12">
          <div data-settings-section><ProfileSection id="profile" /></div>
          <div data-settings-section>
            <MailDomainsSection id="mail-domains" domains={domains} isAdmin={isAdmin} />
          </div>
          {isAdmin && (
            <div data-settings-section>
              <MailboxNamesSection
                id="mailbox-names"
                identities={manageableIdentities}
              />
            </div>
          )}
          {isAdmin && (
            <div data-settings-section>
              <MailboxAccessSection
                id="mailbox-access"
                identities={manageableIdentities}
              />
            </div>
          )}
          {hasOwnedMailboxes && (
            <div data-settings-section>
              <SignaturesSection id="signatures" identities={ownedIdentities} />
            </div>
          )}
          {hasOwnedMailboxes && (
            <div data-settings-section>
              <VacationResponderSection id="vacation" identities={ownedIdentities} />
            </div>
          )}
          <div data-settings-section>
            <LabelsSection id="labels" initialLabels={initialLabels} />
          </div>
          <div data-settings-section>
            <RulesSection
              id="rules"
              identities={ownedIdentities}
              labels={initialLabels}
            />
          </div>
          <div data-settings-section>
            <InboxLayoutEditor
              initialLayouts={initialInboxLayouts}
              savedSearches={savedSearches}
            />
          </div>
          <div data-settings-section>
            <InboxSection id="inbox" />
          </div>
          <div data-settings-section>
            <BlockedSendersSection id="blocked-senders" />
          </div>
          <div data-settings-section>
            <SendingSection id="sending" initialUndoSendSeconds={initialUndoSendSeconds} />
          </div>
          <div data-settings-section>
            <NotificationsSection id="notifications" />
          </div>
          {hasAuditAccess && (
            <div data-settings-section>
              <AuditLogSection id="audit-log" mailboxes={auditMailboxes} />
            </div>
          )}
          <div data-settings-section>
            <CalendarSubscriptionSection id="calendar-subscription" />
          </div>
          <div data-settings-section>
            <ExportSection id="export" ownedIdentities={ownedIdentities} />
          </div>
          {isAdmin && (
            <div data-settings-section>
              <StorageSection id="storage" />
            </div>
          )}
          <div data-settings-section><AppearanceSection id="appearance" /></div>
          <div data-settings-section><AboutSection id="about" /></div>
        </div>
      </div>
    </div>
  );
}

const UNDO_SEND_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
];

// Curated list of common IANA zones (#90). The full IANA tz database is
// hundreds of names, most of which are aliases or rarely-used regional
// identifiers; loading the whole thing into a <datalist> is overkill
// when 95% of users will pick something from this short list. The input
// remains free-form text so anyone who needs a less common zone can
// type it directly — server-side validation via Intl.DateTimeFormat
// catches typos.
const COMMON_TIME_ZONES: string[] = [
  "UTC",
  // Americas
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Sao_Paulo",
  "America/Buenos_Aires",
  "America/Halifax",
  "America/St_Johns",
  "Pacific/Honolulu",
  // Europe
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Oslo",
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  // Africa / Middle East
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Riyadh",
  // Asia
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Taipei",
  "Asia/Seoul",
  "Asia/Tokyo",
  // Oceania
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// Profile section (#90). Currently just the time zone picker — kept as
// its own section so future user-profile fields (display name, avatar,
// etc.) have an obvious home and the Settings nav doesn't need another
// rename round.
function ProfileSection({ id }: { id: string }) {
  // null means "loaded, nothing set" (legacy users); undefined means
  // "haven't fetched yet". The picker disables itself in the undefined
  // state so we don't write before we've read.
  const [defaultTz, setDefaultTz] = useState<string | null | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Device tz is the legacy fallback — surface it next to the input so
  // users understand what "leave blank" means. Computed once; the
  // browser tz doesn't change mid-session in any realistic scenario.
  const deviceTz =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (cancelled || !res.ok) {
          setDefaultTz(null);
          return;
        }
        const j = (await res.json()) as { default_tz?: string | null };
        if (!cancelled) setDefaultTz(j.default_tz ?? null);
      } catch {
        if (!cancelled) setDefaultTz(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function commit(next: string) {
    setError(null);
    const trimmed = next.trim();
    // Empty string clears the pref so future events fall back to device
    // tz. Otherwise we send the raw value through and let the server
    // validate (Intl.DateTimeFormat throws on unknown zones).
    const payload = trimmed === "" ? null : trimmed;
    setDefaultTz(payload);
    startTransition(async () => {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_tz: payload }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  const inputValue = defaultTz === undefined || defaultTz === null ? "" : defaultTz;

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Profile"
        description="Personal preferences that follow you across devices."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4">
        <label htmlFor="settings-default-tz" className="block text-sm font-medium mb-2">
          Time zone
        </label>
        <input
          id="settings-default-tz"
          type="text"
          list="settings-default-tz-options"
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          placeholder={deviceTz ? `Device: ${deviceTz}` : "America/Los_Angeles"}
          onChange={e => setDefaultTz(e.target.value)}
          onBlur={e => {
            // Commit on blur rather than per-keystroke so we don't fire
            // a request for every character of "America/Los_Angeles". A
            // change-then-blur for the same value still no-ops because
            // the server treats an unchanged write as idempotent.
            if (defaultTz !== undefined) commit(e.target.value);
          }}
          disabled={defaultTz === undefined || isPending}
          className="w-full sm:w-72 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
        />
        <datalist id="settings-default-tz-options">
          {COMMON_TIME_ZONES.map(tz => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <p className="mt-2 text-xs text-neutral-500">
          New calendar events default to this zone. Leave blank to fall back
          to your device&rsquo;s time zone
          {deviceTz ? ` (currently ${deviceTz})` : ""}.
        </p>
        <div className="mt-2 text-xs text-neutral-500 flex items-center gap-2">
          {isPending && <span>Saving…</span>}
          {!isPending && savedAt && <span>Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>
    </section>
  );
}

// Inbox automation (#auto-archive). Today this is the opt-in auto-archive of
// the marketing/no-action lane; future inbox-side automation toggles can join
// it here. Off by default — the email-worker reads the saved preference and
// files new (marketing & !action) threads straight to archived on arrival.
function InboxSection({ id }: { id: string }) {
  const [autoArchive, setAutoArchive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSaveTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/preferences");
        if (cancelled || !res.ok) {
          setLoaded(true);
          return;
        }
        const j = (await res.json()) as {
          preferences: { auto_archive_marketing?: boolean };
        };
        if (!cancelled) {
          setAutoArchive(!!j.preferences.auto_archive_marketing);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function change(next: boolean) {
    setError(null);
    setAutoArchive(next);
    startSaveTransition(async () => {
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auto_archive_marketing: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        // Roll back the optimistic flip so the toggle matches server truth.
        setAutoArchive(!next);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Inbox"
        description="How new mail is triaged before you see it."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={autoArchive}
            onChange={e => change(e.target.checked)}
            disabled={!loaded || pending}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="font-medium">Auto-archive newsletters &amp; promotions</span>
            <span className="mt-1 block text-xs text-neutral-500">
              When on, brand-new threads classified as marketing with no action needed (the &ldquo;Newsletters&rdquo; lane) skip the inbox and go straight to Archive — no unread badge, no notification. Receipts and verifications that still want a click (the &ldquo;Bulk action&rdquo; lane) are left alone.
            </span>
            <span className="mt-1 block text-xs text-neutral-500">
              Nothing is deleted: archived mail stays searchable and shows up under <span className="font-medium">Archived</span>. Only applies to mailboxes you own.
            </span>
          </span>
        </label>
        <div className="mt-2 text-xs text-neutral-500 flex items-center gap-2">
          {pending && <span>Saving…</span>}
          {!pending && savedAt && <span>Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>
    </section>
  );
}

function SendingSection({
  id,
  initialUndoSendSeconds,
}: {
  id: string;
  initialUndoSendSeconds: number;
}) {
  const [value, setValue] = useState(initialUndoSendSeconds);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Track-opens default (#69). Loaded async from /api/me/preferences — the
  // user's preferences row is the source of truth. We keep the undo-send
  // and track-opens controls in the same section since both are about
  // "what happens when you press Send by default".
  const [trackOpens, setTrackOpens] = useState(false);
  const [trackOpensLoaded, setTrackOpensLoaded] = useState(false);
  const [trackOpensSavedAt, setTrackOpensSavedAt] = useState<number | null>(null);
  const [trackOpensError, setTrackOpensError] = useState<string | null>(null);
  const [trackOpensPending, startTrackOpensTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/preferences");
        if (cancelled || !res.ok) {
          setTrackOpensLoaded(true);
          return;
        }
        const j = (await res.json()) as {
          preferences: { default_track_opens?: boolean };
        };
        if (!cancelled) {
          setTrackOpens(!!j.preferences.default_track_opens);
          setTrackOpensLoaded(true);
        }
      } catch {
        if (!cancelled) setTrackOpensLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function change(next: number) {
    setError(null);
    setValue(next);
    startTransition(async () => {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ undo_send_seconds: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  function changeTrackOpens(next: boolean) {
    setTrackOpensError(null);
    setTrackOpens(next);
    startTrackOpensTransition(async () => {
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ default_track_opens: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setTrackOpensError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      setTrackOpensSavedAt(Date.now());
    });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Sending"
        description="Defaults for the compose window. Per-message overrides live in the send menu."
      />
      <div className="space-y-4">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4">
          <label className="block text-sm font-medium mb-2">Undo send</label>
          <select
            value={value}
            onChange={e => change(Number(e.target.value))}
            disabled={isPending}
            className="w-full sm:w-48 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
          >
            {UNDO_SEND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-neutral-500">
            Hold outgoing messages briefly so you can undo before they leave. Cron dispatches each minute, so the actual send may follow the countdown by up to a minute.
          </p>
          <div className="mt-2 text-xs text-neutral-500 flex items-center gap-2">
            {isPending && <span>Saving…</span>}
            {!isPending && savedAt && <span>Saved</span>}
            {error && <span className="text-red-600">{error}</span>}
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={trackOpens}
              onChange={e => changeTrackOpens(e.target.checked)}
              disabled={!trackOpensLoaded || trackOpensPending}
              className="mt-0.5"
            />
            <span className="flex-1">
              <span className="font-medium">Track opens by default</span>
              <span className="mt-1 block text-xs text-neutral-500">
                When on, new compose windows start with the &ldquo;Track opens&rdquo; toggle pre-checked. The outbound HTML body carries a 1×1 tracking pixel so we can record when (and how often) the recipient&apos;s mail client loads it.
              </span>
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                Privacy trade-off: trackers like this are widely considered intrusive and many mail clients (including this one&apos;s inbound view) strip remote images by default. Leave this off unless you have a specific reason to need read receipts on every send.
              </span>
            </span>
          </label>
          <div className="mt-2 text-xs text-neutral-500 flex items-center gap-2">
            {trackOpensPending && <span>Saving…</span>}
            {!trackOpensPending && trackOpensSavedAt && <span>Saved</span>}
            {trackOpensError && <span className="text-red-600">{trackOpensError}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function SignaturesSection({ id, identities }: { id: string; identities: Identity[] }) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Signatures"
        description="Per-mailbox signature appended to every outbound message."
      />
      {identities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-8 text-sm text-neutral-500 text-center">
          No mailboxes yet.
        </div>
      ) : (
        <ul className="space-y-4">
          {identities.map(i => (
            <li key={i.mailbox_id}>
              <SignatureEditor identity={i} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SignatureEditor({ identity }: { identity: Identity }) {
  const router = useRouter();
  // Editor is uncontrolled; we hold the latest HTML to ship on Save.
  const [html, setHtml] = useState(identity.signature_html ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${identity.mailbox_id}/signature`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature_html: html || null }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <div className="text-sm font-medium font-mono truncate">
          {identity.local_part}@{identity.domain_name}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {savedAt && <span className="text-xs text-neutral-500">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <RichTextEditor
        initialHtml={identity.signature_html ?? ""}
        placeholder="No signature set"
        minHeight={120}
        onChange={next => setHtml(next)}
      />
    </div>
  );
}

function VacationResponderSection({
  id,
  identities,
}: {
  id: string;
  identities: Identity[];
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Vacation responder"
        description="Auto-reply to inbound mail during a date window. Respects RFC 3834 — bounces, mailing-list traffic, and senders we've already replied to within the cooldown are skipped."
      />
      {identities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-8 text-sm text-neutral-500 text-center">
          No mailboxes yet.
        </div>
      ) : (
        <ul className="space-y-4">
          {identities.map(i => (
            <li key={i.mailbox_id}>
              <VacationResponderEditor identity={i} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface AutoresponderSettings {
  enabled: boolean;
  starts_at: number | null;
  ends_at: number | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  cooldown_hours: number;
}

const DEFAULT_AUTORESPONDER: AutoresponderSettings = {
  enabled: false,
  starts_at: null,
  ends_at: null,
  subject: "Out of office",
  body_text:
    "Thanks for your message — I'm out of the office and will get back to you when I'm back at my desk.",
  body_html: null,
  cooldown_hours: 24,
};

function VacationResponderEditor({ identity }: { identity: Identity }) {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<AutoresponderSettings>(DEFAULT_AUTORESPONDER);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Initial fetch — owner-only endpoint, so a 403 here would mean the owned
  // identity list disagrees with the server. Treated as a load error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/mailboxes/${identity.mailbox_id}/autoresponder`);
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load (${res.status})`);
          setLoaded(true);
          return;
        }
        const j = (await res.json()) as { autoresponder: AutoresponderSettings | null };
        if (!cancelled) {
          if (j.autoresponder) {
            setSettings(j.autoresponder);
          }
          setLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load");
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity.mailbox_id]);

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${identity.mailbox_id}/autoresponder`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800">
        <div className="text-sm font-medium font-mono truncate">
          {identity.local_part}@{identity.domain_name}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {savedAt && <span className="text-xs text-neutral-500">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
          <label className="flex items-center gap-1.5 text-xs select-none">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={e => setSettings(s => ({ ...s, enabled: e.target.checked }))}
              disabled={!loaded || isPending}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            <span>Enabled</span>
          </label>
          <button
            type="button"
            onClick={save}
            disabled={!loaded || isPending}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="px-4 py-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">Starts</span>
            <input
              type="datetime-local"
              value={tsToInput(settings.starts_at)}
              onChange={e =>
                setSettings(s => ({ ...s, starts_at: inputToTs(e.target.value) }))
              }
              disabled={!loaded || isPending}
              className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">Ends</span>
            <input
              type="datetime-local"
              value={tsToInput(settings.ends_at)}
              onChange={e =>
                setSettings(s => ({ ...s, ends_at: inputToTs(e.target.value) }))
              }
              disabled={!loaded || isPending}
              className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
          </label>
        </div>
        <p className="text-[11px] text-neutral-500">
          Leave a date blank for no bound. Times are in your local timezone.
        </p>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Subject</span>
          <input
            type="text"
            value={settings.subject}
            onChange={e => setSettings(s => ({ ...s, subject: e.target.value }))}
            disabled={!loaded || isPending}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Message</span>
          <textarea
            value={settings.body_text}
            onChange={e => setSettings(s => ({ ...s, body_text: e.target.value }))}
            disabled={!loaded || isPending}
            rows={6}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm font-sans focus:outline-none focus:border-[var(--color-brand)]"
          />
        </label>
        <label className="block max-w-[14rem]">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            Cooldown (hours)
          </span>
          <input
            type="number"
            min={1}
            max={720}
            value={settings.cooldown_hours}
            onChange={e =>
              setSettings(s => ({
                ...s,
                cooldown_hours: Math.max(1, Math.floor(Number(e.target.value) || 0)),
              }))
            }
            disabled={!loaded || isPending}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
          <span className="text-[11px] text-neutral-500">
            How long to wait before auto-replying to the same correspondent again.
          </span>
        </label>
      </div>
    </div>
  );
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
// We round-trip via the *local* wall-clock — the browser parses it back into
// UTC unix seconds when the user re-saves. Rough but matches what the user
// types into the picker.
function tsToInput(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inputToTs(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000);
}

interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "member" | "reader";
  created_at: number;
}
const MEMBER_ROLES: Member["role"][] = ["owner", "member", "reader"];

// Optional, per-mailbox friendly name shown in the sidebar nav drawer in
// place of the bare email address ("Sales", "Founders", "Personal" — instead
// of `hello@founders.example.com`). Stored on mailboxes.display_name; the
// existing PATCH /api/mailboxes/<id> already accepts display_name, so this
// is wiring only.
function MailboxNamesSection({ id, identities }: { id: string; identities: Identity[] }) {
  // Aliases inherit from their parent mailbox — show only the underlying
  // mailbox identities so we don't list the same row twice.
  const mailboxes = identities.filter(i => i.kind === "mailbox");
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Mailbox names"
        description="Friendly names shown in the sidebar drawer. Leave blank to fall back to the email address."
      />
      {mailboxes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-8 text-sm text-neutral-500 text-center">
          No mailboxes yet.
        </div>
      ) : (
        <ul className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 divide-y divide-neutral-200 dark:divide-neutral-800">
          {mailboxes.map(i => (
            <li key={i.mailbox_id}>
              <MailboxNameRow identity={i} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MailboxNameRow({ identity }: { identity: Identity }) {
  const router = useRouter();
  const address = `${identity.local_part}@${identity.domain_name}`;
  const initial = identity.display_name ?? "";
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState<string>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function commit() {
    const next = value.trim();
    if (next === saved) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${identity.mailbox_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: next || null }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setSaved(next);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48 text-sm font-mono truncate" title={address}>
        {address}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          placeholder="Display name"
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setValue(saved);
              e.currentTarget.blur();
            }
          }}
          disabled={isPending}
          className="w-56 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
        />
        <span className="text-xs text-neutral-500 w-16 text-right">
          {isPending ? "Saving…" : value.trim() === saved ? "" : "Press ⏎"}
        </span>
      </div>
      {error && <span className="text-xs text-red-600 basis-full">{error}</span>}
    </div>
  );
}

function MailboxAccessSection({ id, identities }: { id: string; identities: Identity[] }) {
  // One row per mailbox in the system (admin view). Each row lazily fetches
  // its member list the first time the row mounts so the page paints fast
  // even with many mailboxes.
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Mailbox access"
        description="Invite collaborators (e.g. a contractor working on a single mailbox) and pick their role: owner, member (read + send), or reader (read-only). They sign in via Cloudflare Access — make sure your Access policy allows their email."
      />
      {identities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-8 text-sm text-neutral-500 text-center">
          No mailboxes yet.
        </div>
      ) : (
        <ul className="space-y-4">
          {identities.map(i => (
            <li key={i.mailbox_id}>
              <MailboxAccessRow identity={i} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MailboxAccessRow({ identity }: { identity: Identity }) {
  const mailboxId = identity.mailbox_id;
  const label = `${identity.local_part}@${identity.domain_name}`;

  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Member["role"]>("member");
  const [isPending, startTransition] = useTransition();

  async function refresh() {
    setLoadError(null);
    const res = await fetch(`/api/mailboxes/${mailboxId}/members`);
    if (!res.ok) {
      setLoadError(`Failed to load members (${res.status})`);
      return;
    }
    const json = (await res.json()) as { members: Member[] };
    setMembers(json.members);
  }

  useEffect(() => {
    // Initial member-list fetch when this mailbox row mounts. Inlined so the
    // useEffect doesn't depend on a `refresh` closure (which would either
    // need useCallback wrapping or eslint disables).
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/mailboxes/${mailboxId}/members`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(`Failed to load members (${res.status})`);
          return;
        }
        const json = (await res.json()) as { members: Member[] };
        if (!cancelled) setMembers(json.members);
      } catch {
        if (!cancelled) setLoadError("Failed to load members");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mailboxId]);

  function invite() {
    setActionError(null);
    if (!inviteEmail.trim()) {
      setActionError("Email required");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${mailboxId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setInviteEmail("");
      setInviteRole("member");
      await refresh();
    });
  }

  function changeRole(userId: string, role: Member["role"]) {
    setActionError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${mailboxId}/members/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      await refresh();
    });
  }

  function remove(userId: string) {
    setActionError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${mailboxId}/members/${userId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      await refresh();
    });
  }

  const memberCount = members?.length ?? 0;

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="text-sm font-medium font-mono truncate">{label}</div>
        {members && (
          <span className="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
            {memberCount === 0
              ? "Just you"
              : `${memberCount} ${memberCount === 1 ? "member" : "members"}`}
          </span>
        )}
      </div>

      {(loadError || members === null || (members && members.length > 0)) && (
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          {loadError && (
            <div className="px-4 py-2 text-xs text-red-600">{loadError}</div>
          )}
          {members === null && !loadError && (
            <div className="px-4 py-2 text-xs text-neutral-500">Loading…</div>
          )}
          {members && members.length > 0 && (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {members.map(m => (
                <li
                  key={m.user_id}
                  className="flex items-center justify-between gap-2 px-4 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm truncate">{m.display_name || m.email}</div>
                    {m.display_name && (
                      <div className="text-[11px] text-neutral-500 truncate">
                        {m.email}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <select
                      value={m.role}
                      onChange={e =>
                        changeRole(m.user_id, e.target.value as Member["role"])
                      }
                      disabled={isPending}
                      className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-xs px-1.5 py-0.5 focus:outline-none focus:border-[var(--color-brand)]"
                    >
                      {MEMBER_ROLES.map(r => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => remove(m.user_id)}
                      disabled={isPending}
                      className="rounded-md px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 px-4 py-3 flex items-center gap-2">
        <input
          type="email"
          placeholder="contractor@example.com"
          value={inviteEmail}
          onChange={e => setInviteEmail(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") invite();
          }}
          className="flex-1 min-w-0 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        />
        <select
          value={inviteRole}
          onChange={e => setInviteRole(e.target.value as Member["role"])}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        >
          {MEMBER_ROLES.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={invite}
          disabled={isPending}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          Invite
        </button>
      </div>
      {actionError && (
        <div className="px-4 py-2 text-xs text-red-600 border-t border-neutral-200 dark:border-neutral-800">
          {actionError}
        </div>
      )}
    </div>
  );
}

function MailDomainsSection({
  id,
  domains,
  isAdmin,
}: {
  id: string;
  domains: DomainRow[];
  isAdmin: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Mail domains"
        description="Domains routed to orange-inbox. Adding a domain creates a default catch-all mailbox you own."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
        {domains.length === 0 ? (
          <div className="px-4 py-8 text-sm text-neutral-500 text-center">
            No domains yet.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {domains.map(d => (
              <li
                key={d.id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="h-7 w-7 rounded-md bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-500 shrink-0">
                  <GlobeIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{d.name}</div>
                  {d.display_name && (
                    <div className="text-xs text-neutral-500 truncate">{d.display_name}</div>
                  )}
                </div>
                {isAdmin && (
                  <AddMailboxToDomainButton domainId={d.id} domainName={d.name} />
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 px-4 py-3">
            <AddDomainForm />
          </div>
        )}
      </div>
    </section>
  );
}

function AddMailboxToDomainButton({
  domainId,
  domainName,
}: {
  domainId: string;
  domainName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Add mailbox
      </button>
      {open && (
        <AddMailboxDialog
          domainId={domainId}
          domainName={domainName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AddDomainForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [createCatchAll, setCreateCatchAll] = useState(true);
  const [localPart, setLocalPart] = useState("hello");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter a domain");
      return;
    }
    const trimmedLocal = localPart.trim().toLowerCase();
    if (createCatchAll && !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(trimmedLocal)) {
      setError("Local part must be alphanumeric (letters, digits, . _ + -)");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          create_catch_all: createCatchAll,
          default_local_part: createCatchAll ? trimmedLocal : undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setName("");
      setCreateCatchAll(true);
      setLocalPart("hello");
      router.refresh();
    });
  }

  const previewName = name.trim().toLowerCase() || "example.com";
  const previewLocal = localPart.trim().toLowerCase() || "hello";

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="example.com"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add domain"}
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={createCatchAll}
          onChange={e => setCreateCatchAll(e.target.checked)}
        />
        <span>Create catch-all mailbox</span>
      </label>
      {createCatchAll && (
        <div className="flex items-center gap-2 text-xs">
          <label htmlFor="catch-all-local" className="shrink-0 text-neutral-600 dark:text-neutral-400">
            Local part
          </label>
          <input
            id="catch-all-local"
            type="text"
            placeholder="hello"
            value={localPart}
            onChange={e => setLocalPart(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") submit();
            }}
            className="w-32 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 font-mono focus:border-[var(--color-brand)] focus:outline-none"
          />
          <span className="text-neutral-500 truncate">→ {previewLocal}@{previewName}</span>
        </div>
      )}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

function LabelsSection({ id, initialLabels }: { id: string; initialLabels: LabelRow[] }) {
  const router = useRouter();
  const [labels, setLabels] = useState<LabelRow[]>(initialLabels);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);

  async function refresh() {
    setLoadError(null);
    const res = await fetch("/api/labels");
    if (!res.ok) {
      setLoadError(`Failed to load labels (${res.status})`);
      return;
    }
    const json = (await res.json()) as { labels: LabelRow[] };
    setLabels(json.labels);
  }

  function create() {
    setActionError(null);
    const name = newName.trim();
    if (!name) {
      setActionError("Enter a name");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setNewName("");
      setNewColor(null);
      await refresh();
      router.refresh();
    });
  }

  function startEdit(l: LabelRow) {
    setActionError(null);
    setEditingId(l.id);
    setEditName(l.name);
    setEditColor(l.color);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditColor(null);
  }

  function saveEdit(id: string) {
    setActionError(null);
    const name = editName.trim();
    if (!name) {
      setActionError("Name required");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/labels/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: editColor }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      cancelEdit();
      await refresh();
      router.refresh();
    });
  }

  function remove(l: LabelRow) {
    if (!confirm(`Delete label "${l.name}"? It will be removed from all threads.`)) {
      return;
    }
    setActionError(null);
    startTransition(async () => {
      const res = await fetch(`/api/labels/${l.id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      await refresh();
      router.refresh();
    });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader title="Labels" description="Tags you can apply to conversations." />

      {loadError && <div className="text-sm text-red-600 mb-2">{loadError}</div>}
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
        {labels.length === 0 ? (
          <div className="px-4 py-8 text-sm text-neutral-500 text-center">
            No labels yet.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {labels.map(l =>
              editingId === l.id ? (
                <li key={l.id} className="px-4 py-3 space-y-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") saveEdit(l.id);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
                  />
                  <ColorPicker value={editColor} onChange={setEditColor} />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="rounded-md px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => saveEdit(l.id)}
                      disabled={isPending}
                      className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                </li>
              ) : (
                <li
                  key={l.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <LabelChip name={l.name} color={l.color} size="sm" />
                    {l.mailbox_id && (
                      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                        mailbox
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => startEdit(l)}
                      disabled={isPending}
                      className="text-xs text-neutral-600 hover:underline disabled:opacity-50 dark:text-neutral-400"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(l)}
                      disabled={isPending}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 px-4 py-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-neutral-500">
            New label
          </div>
          <input
            type="text"
            placeholder="e.g. Receipts"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") create();
            }}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
          <ColorPicker value={newColor} onChange={setNewColor} />
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={create}
              disabled={isPending}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {isPending ? "Creating…" : "Create label"}
            </button>
          </div>
        </div>
      </div>
      {actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}
    </section>
  );
}

function RulesSection({
  id,
  identities,
  labels,
}: {
  id: string;
  identities: Identity[];
  labels: LabelRow[];
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Rules"
        description="Automatically tag, archive, mark read, or delete inbound mail. Rules run in order; the first matching archive/delete wins."
      />
      <RulesEditor identities={identities} labels={labels} />
    </section>
  );
}

interface BlockedSenderRow {
  mailbox_id: string;
  addr: string;
  blocked_at: number;
  mailbox_label: string;
}

function BlockedSendersSection({ id }: { id: string }) {
  const [rows, setRows] = useState<BlockedSenderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/blocked-senders");
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(`Failed to load (${res.status})`);
        return;
      }
      const j = (await res.json()) as { blocked_senders: BlockedSenderRow[] };
      if (!cancelled) setRows(j.blocked_senders);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function unblock(mailboxId: string, addr: string) {
    setActionError(null);
    startTransition(async () => {
      const res = await fetch("/api/blocked-senders", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mailbox_id: mailboxId, addr }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setRows(prev =>
        prev ? prev.filter(r => !(r.mailbox_id === mailboxId && r.addr === addr)) : prev,
      );
    });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Blocked senders"
        description="Mail from these addresses lands archived from the start. Unblock to restore normal delivery — past messages stay where they are."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
        {loadError && <div className="px-4 py-3 text-sm text-red-600">{loadError}</div>}
        {!loadError && rows === null && (
          <div className="px-4 py-8 text-sm text-neutral-500 text-center">Loading…</div>
        )}
        {rows && rows.length === 0 && (
          <div className="px-4 py-8 text-sm text-neutral-500 text-center">
            Nobody&apos;s blocked. Add someone via the message menu (•••) on a thread.
          </div>
        )}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map(r => (
              <li
                key={`${r.mailbox_id}:${r.addr}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-mono truncate">{r.addr}</div>
                  <div className="text-[11px] text-neutral-500 truncate">
                    blocking on {r.mailbox_label}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => unblock(r.mailbox_id, r.addr)}
                  disabled={isPending}
                  className="shrink-0 text-xs text-neutral-600 hover:underline disabled:opacity-50 dark:text-neutral-400"
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}
    </section>
  );
}

function NotificationsSection({ id }: { id: string }) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Notifications"
        description="Get a phone-style notification when new mail arrives. Subscription is per-device — turn it on once on each device you use."
      />
      <PushNotificationToggle />
    </section>
  );
}

interface IcsFeed {
  scope: string;
  label: string;
  token: string;
  created_at: number;
  last_used_at: number | null;
  webcal_url: string;
  https_url: string;
}

interface IcsSubscriptionState {
  mode: "single" | "per_mailbox";
  feeds: IcsFeed[];
}

// "Calendar subscription" card — exposes the user's webcal:// feed URL(s) so
// they can paste them into Google Calendar, Apple Calendar, Outlook, etc.
//
// Two modes, toggled on the card: "single" is one URL for the whole
// calendar; "per_mailbox" is a separate URL for Personal and each mailbox.
// GET lazy-mints whatever the current mode is missing; switching modes
// (POST set_mode) revokes the old URLs and mints the new set.
function CalendarSubscriptionSection({ id }: { id: string }) {
  const [state, setState] = useState<IcsSubscriptionState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Two-click confirm for the destructive mode switch — holds the mode we're
  // about to switch TO, or null.
  const [confirmingMode, setConfirmingMode] = useState<
    "single" | "per_mailbox" | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/calendar/subscription");
        if (cancelled) return;
        if (!res.ok) {
          setError(`Load failed (${res.status})`);
          setLoaded(true);
          return;
        }
        const j = (await res.json()) as IcsSubscriptionState;
        if (cancelled) return;
        setState(j);
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setError("Load failed");
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function switchMode(target: "single" | "per_mailbox") {
    if (state?.mode === target) return;
    // First click arms the confirm; second click (here or via "Switch
    // anyway") goes through.
    if (confirmingMode !== target) {
      setConfirmingMode(target);
      return;
    }
    setConfirmingMode(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/calendar/subscription", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set_mode", mode: target }),
        });
        if (!res.ok) {
          setError(`Switch failed (${res.status})`);
          return;
        }
        setState((await res.json()) as IcsSubscriptionState);
      } catch {
        setError("Switch failed");
      }
    });
  }

  // Rotate one feed's token. Returns whether it succeeded so the row can
  // show its own confirmation message.
  async function rotateFeed(scope: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch("/api/calendar/subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rotate", scope }),
      });
      if (!res.ok) {
        setError(`Rotate failed (${res.status})`);
        return false;
      }
      setState((await res.json()) as IcsSubscriptionState);
      return true;
    } catch {
      setError("Rotate failed");
      return false;
    }
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Calendar subscription"
        description="Mirror your calendar into Google, Apple, or Outlook by subscribing to this URL. The link is read-only and rotates with one click if you ever need to revoke access."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 space-y-4">
        {!loaded && <p className="text-xs text-neutral-500">Loading…</p>}
        {loaded && state && (
          <>
            <div className="space-y-2">
              <div className="inline-flex rounded-md border border-neutral-300 dark:border-neutral-700 p-0.5 text-xs">
                {(["single", "per_mailbox"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    disabled={isPending}
                    className={`rounded px-3 py-1 font-medium transition-colors disabled:opacity-50 ${
                      state.mode === m
                        ? "bg-[var(--color-brand)] text-white"
                        : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {m === "single" ? "Single feed" : "One per mailbox"}
                  </button>
                ))}
              </div>
              <p className="text-xs text-neutral-500">
                {state.mode === "single"
                  ? "One URL covers every calendar."
                  : "A separate URL for Personal and each mailbox — subscribe only the ones you want."}
              </p>
              {confirmingMode && (
                <p className="text-xs text-red-600">
                  Switching revokes your current subscription URL
                  {state.feeds.length > 1 ? "s" : ""} — anything already
                  subscribed stops syncing.{" "}
                  <button
                    type="button"
                    onClick={() => switchMode(confirmingMode)}
                    className="font-medium underline"
                  >
                    Switch anyway
                  </button>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setConfirmingMode(null)}
                    className="underline"
                  >
                    Cancel
                  </button>
                </p>
              )}
            </div>
            <div className="space-y-3">
              {state.feeds.map(f => (
                <CalendarFeedRow
                  key={f.scope}
                  feed={f}
                  showLabel={state.mode === "per_mailbox"}
                  busy={isPending}
                  onRotate={rotateFeed}
                />
              ))}
            </div>
          </>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </section>
  );
}

// One subscription URL within the card — its own copy / rotate controls and
// confirmation state so several can render stacked in per-mailbox mode.
function CalendarFeedRow({
  feed,
  showLabel,
  busy,
  onRotate,
}: {
  feed: IcsFeed;
  showLabel: boolean;
  busy: boolean;
  onRotate: (scope: string) => Promise<boolean>;
}) {
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(feed.webcal_url);
      setCopyMsg("Copied.");
    } catch {
      // Clipboard write rejected (insecure context, or permission). Surface
      // a fallback prompt so the URL is still reachable.
      setCopyMsg("Copy failed — long-press the URL above to copy manually.");
    }
  }

  async function rotate() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setCopyMsg(null);
    setRotating(true);
    const ok = await onRotate(feed.scope);
    setRotating(false);
    if (ok) setCopyMsg("New URL minted — old subscribers will stop syncing.");
  }

  return (
    <div
      className={
        showLabel
          ? "rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-3 space-y-2"
          : "space-y-2"
      }
    >
      {showLabel && (
        <div className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          {feed.label}
        </div>
      )}
      <label className="block text-xs uppercase tracking-wider text-neutral-500">
        Subscription URL
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          readOnly
          value={feed.webcal_url}
          onFocus={e => e.currentTarget.select()}
          className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 px-3 py-1.5 text-xs font-mono select-all focus:outline-none focus:border-[var(--color-brand)]"
        />
        <button
          type="button"
          onClick={copyUrl}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          Copy
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Click below if your calendar app doesn&rsquo;t recognise <code>webcal://</code>:
        {" "}
        <a
          href={feed.https_url}
          className="underline text-[var(--color-brand)]"
          target="_blank"
          rel="noopener noreferrer"
        >
          {feed.https_url}
        </a>
      </p>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500 pt-2 border-t border-neutral-200 dark:border-neutral-800">
        <span>
          Created{" "}
          <span className="text-neutral-700 dark:text-neutral-300">
            {formatRelativeTimestamp(feed.created_at)}
          </span>
        </span>
        <span>
          Last used{" "}
          <span className="text-neutral-700 dark:text-neutral-300">
            {feed.last_used_at
              ? formatRelativeTimestamp(feed.last_used_at)
              : "never"}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={rotate}
          disabled={busy || rotating}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            confirming
              ? "border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
              : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          }`}
        >
          {rotating
            ? "Rotating…"
            : confirming
              ? "Confirm: revoke and mint new"
              : "Rotate token"}
        </button>
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Cancel
          </button>
        )}
        {copyMsg && (
          <span className="text-xs text-neutral-500">{copyMsg}</span>
        )}
      </div>
    </div>
  );
}

// Tiny relative-time formatter scoped to this section. The big i18n libraries
// are overkill for one timestamp; "5 minutes ago" / "yesterday" is enough.
function formatRelativeTimestamp(unix: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unix;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

// Eight curated swatches across the colour wheel. The Tailwind 500-step hex
// values, so a user picking "blue" gets the same blue Tailwind would render
// for `bg-blue-500`.
const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "orange", hex: "#f97316" },
  { name: "red", hex: "#ef4444" },
  { name: "amber", hex: "#f59e0b" },
  { name: "emerald", hex: "#10b981" },
  { name: "cyan", hex: "#06b6d4" },
  { name: "blue", hex: "#3b82f6" },
  { name: "violet", hex: "#8b5cf6" },
  { name: "pink", hex: "#ec4899" },
];

const THEME_OPTIONS: { value: Theme; label: string; description: string }[] = [
  { value: "light", label: "Light", description: "Always light." },
  { value: "dark", label: "Dark", description: "Always dark." },
  { value: "system", label: "System", description: "Match your OS." },
];

const DENSITY_OPTIONS: { value: Density; label: string; description: string }[] = [
  { value: "comfortable", label: "Comfortable", description: "Default spacing." },
  { value: "cozy", label: "Cozy", description: "Tighter rows." },
  { value: "compact", label: "Compact", description: "Densest — power users." },
];

function AppearanceSection({ id }: { id: string }) {
  // Optimistically apply changes locally as they're picked, then PATCH the
  // server. On success, sync the orange-prefs cookie so the next SSR render
  // (e.g. a hard refresh) starts in the chosen state. Errors revert.
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hexInput, setHexInput] = useState<string>(DEFAULT_PREFERENCES.accent_hex);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me/preferences");
        if (cancelled) return;
        if (!res.ok) {
          setLoaded(true);
          return;
        }
        const j = (await res.json()) as { preferences: UserPreferences };
        if (cancelled) return;
        setPrefs(j.preferences);
        setHexInput(j.preferences.accent_hex);
        setLoaded(true);
        // Sync the cookie so the next SSR render is in the chosen state even
        // if this is the first time we've seen prefs on this device.
        writePrefsCookie(j.preferences);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the latest prefs onto <html> so the picked theme/accent take effect
  // immediately. We do this in an effect (not inline during a click handler)
  // so React's immutability rule sees the DOM mutation as a side-effect tied
  // to render output.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.dataset.density = prefs.density;
    document.documentElement.style.setProperty("--brand", prefs.accent_hex);
  }, [prefs]);

  function persist(next: UserPreferences) {
    setError(null);
    const previous = prefs;
    setPrefs(next);
    startTransition(async () => {
      const res = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        // Roll back the optimistic UI on failure — the effect above will
        // re-mirror `previous` onto <html>.
        setPrefs(previous);
        return;
      }
      writePrefsCookie(next);
      setSavedAt(Date.now());
    });
  }

  function pickTheme(theme: Theme) {
    persist({ ...prefs, theme });
  }

  function pickDensity(density: Density) {
    persist({ ...prefs, density });
  }

  function pickAccent(hex: string) {
    setHexInput(hex);
    persist({ ...prefs, accent_hex: hex });
  }

  function commitHexInput() {
    const normalised = normaliseHexClient(hexInput);
    if (!normalised) {
      setError("Invalid hex color");
      setHexInput(prefs.accent_hex);
      return;
    }
    if (normalised === prefs.accent_hex) return;
    persist({ ...prefs, accent_hex: normalised });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Appearance"
        description="Theme and accent colour. Stored per user — the same account on a different device will pick these up automatically."
      />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 space-y-5">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
            Theme
          </div>
          <div className="flex flex-wrap gap-2">
            {THEME_OPTIONS.map(opt => {
              const active = prefs.theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => pickTheme(opt.value)}
                  disabled={!loaded || isPending}
                  aria-pressed={active}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-neutral-900 dark:text-neutral-100"
                      : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  } disabled:opacity-50`}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
            Density
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Row density">
            {DENSITY_OPTIONS.map(opt => {
              const active = prefs.density === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => pickDensity(opt.value)}
                  disabled={!loaded || isPending}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-neutral-900 dark:text-neutral-100"
                      : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  } disabled:opacity-50`}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
            Accent colour
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map(p => {
              const active = prefs.accent_hex.toLowerCase() === p.hex.toLowerCase();
              return (
                <button
                  key={p.hex}
                  type="button"
                  onClick={() => pickAccent(p.hex)}
                  disabled={!loaded || isPending}
                  aria-label={p.name}
                  aria-pressed={active}
                  title={p.name}
                  style={{ backgroundColor: p.hex }}
                  className={`h-7 w-7 rounded-full border-2 transition-all ${
                    active
                      ? "border-neutral-900 dark:border-neutral-100 scale-110"
                      : "border-transparent"
                  } disabled:opacity-50`}
                />
              );
            })}
          </div>
        </div>

        <div>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Custom hex
            </span>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="h-7 w-7 rounded-md border border-neutral-300 dark:border-neutral-700 shrink-0"
                style={{ backgroundColor: prefs.accent_hex }}
                aria-hidden
              />
              <input
                type="text"
                value={hexInput}
                onChange={e => setHexInput(e.target.value)}
                onBlur={commitHexInput}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                disabled={!loaded || isPending}
                placeholder="#f97316"
                spellCheck={false}
                className="w-32 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm font-mono focus:outline-none focus:border-[var(--color-brand)] disabled:opacity-50"
              />
            </div>
          </label>
        </div>

        <div className="text-xs text-neutral-500 flex items-center gap-2">
          {isPending && <span>Saving…</span>}
          {!isPending && savedAt && <span>Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      </div>
    </section>
  );
}

// Mirror of preferences.ts:normaliseHex — kept client-side to avoid bundling
// the server-only db module via that file (it's pure validation).
function normaliseHexClient(v: string): string | null {
  const trimmed = v.trim().toLowerCase();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  return null;
}

// 1-year max-age — the cookie is the SSR source of truth; expiring it would
// make us paint with defaults until the bootstrap fetch completes. Path=/ so
// it covers every route. SameSite=Lax matches our auth flow (Cloudflare
// Access redirects to the host worker) and avoids CSRF on PATCH.
function writePrefsCookie(p: UserPreferences) {
  if (typeof document === "undefined") return;
  const value = encodeURIComponent(encodePreferencesCookie(p));
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${PREFS_COOKIE}=${value}; Max-Age=${oneYear}; Path=/; SameSite=Lax`;
}

function AboutSection({ id }: { id: string }) {
  const pwa = usePWAUpdate();
  const [msg, setMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onClick() {
    setMsg(null);
    if (pwa.needRefresh) {
      pwa.applyUpdate();
      return;
    }
    startTransition(async () => {
      const updated = await pwa.checkForUpdate();
      if (!updated) setMsg("You're on the latest version.");
    });
  }

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader title="About" description="" />
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 text-sm space-y-3">
        <div className="flex justify-between">
          <span className="text-neutral-500">Version</span>
          <span className="font-medium">{APP_VERSION}</span>
        </div>
        {pwa.supported && (
          <button
            type="button"
            onClick={onClick}
            disabled={isPending}
            className="w-full rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pwa.needRefresh
              ? "Update available — Reload"
              : isPending
                ? "Checking…"
                : "Check for updates"}
          </button>
        )}
        {msg && <p className="text-xs text-center text-neutral-500">{msg}</p>}
      </div>
    </section>
  );
}

// Bidirectional .mbox: download a backup, or upload one to migrate from
// Gmail Takeout / Apple Mail / Thunderbird / a previous orange-inbox export.
// Both share an `id` so the section nav lands on this single block.
function ExportSection({
  id,
  ownedIdentities,
}: {
  id: string;
  ownedIdentities: Identity[];
}) {
  const [exportScope, setExportScope] = useState<string>("all");
  const exportHref =
    exportScope === "all"
      ? "/api/export/mbox"
      : `/api/export/mbox?mailbox_id=${encodeURIComponent(exportScope)}`;

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Import / Export"
        description="Move your mail in and out as standard .mbox files. Compatible with Apple Mail, Thunderbird, Gmail Takeout, mutt, and the orange-inbox round-trip."
      />
      <div className="space-y-4">
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 text-sm space-y-3">
          <h3 className="text-sm font-semibold">Download backup</h3>
          {ownedIdentities.length > 1 && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-neutral-500">Scope</span>
              <select
                value={exportScope}
                onChange={e => setExportScope(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
              >
                <option value="all">All mail you can read</option>
                {ownedIdentities.map(i => (
                  <option key={i.mailbox_id} value={i.mailbox_id}>
                    {i.local_part}@{i.domain_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <a
            href={exportHref}
            download
            className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Download .mbox
          </a>
          <p className="text-xs text-neutral-500">
            Outbound messages are reconstructed from the JSON archive; inbound is
            verbatim. Attachments are inline.
          </p>
        </div>
        {ownedIdentities.length > 0 && (
          <ImportPanel ownedIdentities={ownedIdentities} />
        )}
      </div>
    </section>
  );
}

// Upload a .mbox file and ingest it into a chosen mailbox. Hard cap is 25 MB
// / 500 messages per request — keeps us under Workers' body and CPU limits.
// Larger files need to be split before importing.
function ImportPanel({ ownedIdentities }: { ownedIdentities: Identity[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<string>(ownedIdentities[0]?.mailbox_id ?? "");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "uploading" }
    | { kind: "done"; imported: number; duplicates: number; errors: number; samples: { index: number; reason: string }[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function submit() {
    if (!file || !target) return;
    setStatus({ kind: "uploading" });
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(
        `/api/import/mbox?mailbox_id=${encodeURIComponent(target)}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: buf,
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setStatus({
          kind: "error",
          message: b.message || b.error || `Upload failed (${res.status})`,
        });
        return;
      }
      const b = (await res.json()) as {
        imported: number;
        duplicates: number;
        errors: number;
        error_samples: { index: number; reason: string }[];
      };
      setStatus({
        kind: "done",
        imported: b.imported,
        duplicates: b.duplicates,
        errors: b.errors,
        samples: b.error_samples,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sizeLabel = file
    ? file.size > 1024 * 1024
      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
      : `${(file.size / 1024).toFixed(0)} KB`
    : null;

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 text-sm space-y-3">
      <h3 className="text-sm font-semibold">Import .mbox</h3>
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-neutral-500">Target mailbox</span>
        <select
          value={target}
          onChange={e => setTarget(e.target.value)}
          className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        >
          {ownedIdentities.map(i => (
            <option key={i.mailbox_id} value={i.mailbox_id}>
              {i.local_part}@{i.domain_name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-neutral-500">File</span>
        <input
          type="file"
          accept=".mbox,application/mbox,application/octet-stream,text/plain"
          onChange={e => {
            setFile(e.target.files?.[0] ?? null);
            setStatus({ kind: "idle" });
          }}
          className="mt-1 block w-full text-xs"
        />
        {sizeLabel && (
          <span className="text-xs text-neutral-500">{file?.name} · {sizeLabel}</span>
        )}
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={!file || !target || status.kind === "uploading"}
        className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:opacity-90"
      >
        {status.kind === "uploading" ? "Importing…" : "Import"}
      </button>
      {status.kind === "done" && (
        <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 p-2 text-xs">
          <div className="font-medium text-emerald-800 dark:text-emerald-200">
            Imported {status.imported} message{status.imported === 1 ? "" : "s"}
            {status.duplicates > 0 && ` · skipped ${status.duplicates} duplicate${status.duplicates === 1 ? "" : "s"}`}
            {status.errors > 0 && ` · ${status.errors} error${status.errors === 1 ? "" : "s"}`}
          </div>
          {status.samples.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-emerald-700 dark:text-emerald-300">
              {status.samples.map((s, i) => (
                <li key={i}>#{s.index}: {s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status.kind === "error" && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 p-2 text-xs text-red-800 dark:text-red-200">
          {status.message}
        </div>
      )}
      <p className="text-xs text-neutral-500">
        Capped at 25 MB / 500 messages per request. Larger files (e.g. multi-GB
        Gmail Takeout) need to be split into chunks first. Imports are idempotent
        — re-running on the same file skips messages already present.
      </p>
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </svg>
  );
}

// Admin-only Storage Explorer — top senders / threads / per-domain summary.
// Lazy-loads from /api/storage/explorer on first mount because the queries
// fan out across every mail DB and shouldn't run on every settings page hit.
function StorageSection({ id }: { id: string }) {
  const [data, setData] = useState<{
    senders: StorageSenderRow[];
    threads: StorageThreadRow[];
    domains: StorageDomainRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/storage/explorer");
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load (${res.status})`);
          return;
        }
        const j = (await res.json()) as {
          senders: StorageSenderRow[];
          threads: StorageThreadRow[];
          domains: StorageDomainRow[];
        };
        if (!cancelled) setData(j);
      } catch {
        if (!cancelled) setError("Failed to load storage stats");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBytes = data?.domains.reduce((s, d) => s + d.bytes, 0) ?? 0;
  const totalThreads = data?.domains.reduce((s, d) => s + d.thread_count, 0) ?? 0;
  const totalMessages = data?.domains.reduce((s, d) => s + d.msg_count, 0) ?? 0;

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Storage"
        description={
          data
            ? `${formatBytes(totalBytes)} across ${totalThreads.toLocaleString()} threads / ${totalMessages.toLocaleString()} messages. Bytes are LENGTH(text_body) + attachment sizes; raw .eml and rendered HTML in R2 are excluded, so treat as a relative ranking.`
            : "Top senders, threads, and per-domain summary across all mail DBs."
        }
      />
      {error ? (
        <div className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-900/20 px-4 py-3 text-xs text-rose-800 dark:text-rose-300">
          {error}
        </div>
      ) : data === null ? (
        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-8 text-sm text-neutral-500 text-center">
          Loading…
        </div>
      ) : (
        <div className="space-y-8">
          <StorageTable
            title="Top senders by storage"
            empty="No messages yet."
            columns={["Sender", "Messages", "Storage"]}
            align={["left", "right", "right"]}
            rows={data.senders.map(s => [
              <span key="addr" className="truncate inline-block max-w-[28rem] align-bottom">
                {s.from_addr || <span className="italic text-neutral-500">(unknown)</span>}
              </span>,
              s.msg_count.toLocaleString(),
              formatBytes(s.bytes),
            ])}
          />
          <StorageTable
            title="Top threads by storage"
            empty="No threads yet."
            columns={["Subject", "Mailbox", "Messages", "Storage"]}
            align={["left", "left", "right", "right"]}
            rows={data.threads.map(t => [
              <span key="subj" className="truncate inline-block max-w-[24rem] align-bottom">
                {t.subject?.trim() || <span className="italic text-neutral-500">(no subject)</span>}
              </span>,
              <span key="mbox" className="truncate inline-block max-w-[14rem] align-bottom text-neutral-600 dark:text-neutral-400">
                {t.mailbox_label ?? <span className="italic text-neutral-500">(missing index row)</span>}
              </span>,
              t.msg_count.toLocaleString(),
              formatBytes(t.bytes),
            ])}
          />
          <StorageTable
            title="By sender domain"
            empty="No messages yet."
            columns={["Domain", "Threads", "Messages", "Storage"]}
            align={["left", "right", "right", "right"]}
            rows={data.domains.map(d => [
              d.domain,
              d.thread_count.toLocaleString(),
              d.msg_count.toLocaleString(),
              formatBytes(d.bytes),
            ])}
          />
        </div>
      )}
    </section>
  );
}

function StorageTable({
  title,
  empty,
  columns,
  align,
  rows,
}: {
  title: string;
  empty: string;
  columns: string[];
  align: ("left" | "right")[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-neutral-50 dark:bg-neutral-900/50">
              <tr className="text-xs uppercase tracking-wider text-neutral-500">
                {columns.map((c, i) => (
                  <th
                    key={c}
                    className={`py-2 px-3 font-medium ${align[i] === "right" ? "text-right" : "text-left"}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr
                  key={idx}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`py-2 px-3 ${align[ci] === "right" ? "text-right tabular-nums" : ""}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Per-mailbox audit log (#28). Any user who's a member of at least one
// mailbox sees this section; the picker inside AuditLogView limits the view
// to mailboxes the user can actually read.
function AuditLogSection({
  id,
  mailboxes,
}: {
  id: string;
  mailboxes: Identity[];
}) {
  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Audit log"
        description="Who did what on a shared mailbox — assignments, archives, replies, labels, internal notes. Read access matches mailbox membership: every member of a mailbox sees that mailbox's trail."
      />
      <AuditLogView
        mailboxes={mailboxes.map(i => ({
          id: i.mailbox_id,
          local_part: i.local_part,
          domain_name: i.domain_name,
          display_name: i.display_name,
        }))}
      />
    </section>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {description && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 leading-relaxed max-w-xl">
          {description}
        </p>
      )}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESET_COLORS.map((c, i) => {
        const isSelected = value === c;
        return (
          <button
            key={c ?? "none"}
            type="button"
            onClick={() => onChange(c)}
            aria-label={c ?? "no color"}
            title={c ?? "no color"}
            className={`h-6 w-6 rounded-full border transition-all ${
              isSelected
                ? "border-neutral-900 dark:border-neutral-100 scale-110"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
            style={{
              backgroundColor: c ?? "transparent",
              backgroundImage: c
                ? undefined
                : "linear-gradient(45deg, transparent 45%, #d4d4d4 45% 55%, transparent 55%)",
            }}
          >
            {i === 0 && !c && <span className="sr-only">no color</span>}
          </button>
        );
      })}
    </div>
  );
}
