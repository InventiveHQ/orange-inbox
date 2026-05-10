"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DomainRow } from "@/lib/queries";
import type { Identity } from "@/lib/identities";
import type { LabelRow } from "@/lib/labels";
import { APP_VERSION } from "@/lib/version";
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
  isAdmin: boolean;
  initialUndoSendSeconds: number;
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
  isAdmin,
  initialUndoSendSeconds,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasOwnedMailboxes = ownedIdentities.length > 0;
  const sections = useMemo(
    () => [
      { id: "mail-domains", label: "Mail domains" },
      ...(isAdmin ? [{ id: "mailbox-access", label: "Mailbox access" }] : []),
      ...(hasOwnedMailboxes ? [{ id: "signatures", label: "Signatures" }] : []),
      ...(hasOwnedMailboxes ? [{ id: "vacation", label: "Vacation responder" }] : []),
      { id: "labels", label: "Labels" },
      { id: "rules", label: "Rules" },
      { id: "blocked-senders", label: "Blocked senders" },
      { id: "sending", label: "Sending" },
      { id: "notifications", label: "Notifications" },
      { id: "export", label: "Import / Export" },
      { id: "about", label: "About" },
    ],
    [isAdmin, hasOwnedMailboxes],
  );
  const active = useActiveSection(
    scrollRef,
    sections.map(s => s.id),
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 flex gap-10">
          <aside className="hidden md:block w-44 shrink-0">
            <nav className="sticky top-0 space-y-0.5">
              {sections.map(s => (
                <SectionNavLink
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  active={active === s.id}
                  scrollRoot={scrollRef}
                />
              ))}
            </nav>
          </aside>
          <div className="flex-1 min-w-0 space-y-12">
            <MailDomainsSection id="mail-domains" domains={domains} isAdmin={isAdmin} />
            {isAdmin && (
              <MailboxAccessSection
                id="mailbox-access"
                identities={manageableIdentities}
              />
            )}
            {hasOwnedMailboxes && (
              <SignaturesSection id="signatures" identities={ownedIdentities} />
            )}
            {hasOwnedMailboxes && (
              <VacationResponderSection id="vacation" identities={ownedIdentities} />
            )}
            <LabelsSection id="labels" initialLabels={initialLabels} />
            <RulesSection
              id="rules"
              identities={ownedIdentities}
              labels={initialLabels}
            />
            <BlockedSendersSection id="blocked-senders" />
            <SendingSection id="sending" initialUndoSendSeconds={initialUndoSendSeconds} />
            <NotificationsSection id="notifications" />
            <ExportSection id="export" ownedIdentities={ownedIdentities} />
            <AboutSection id="about" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionNavLink({
  id,
  label,
  active,
  scrollRoot,
}: {
  id: string;
  label: string;
  active: boolean;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <a
      href={`#${id}`}
      onClick={e => {
        e.preventDefault();
        const el = document.getElementById(id);
        const root = scrollRoot.current;
        if (!el || !root) return;
        const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
        root.scrollTo({ top, behavior: "smooth" });
        history.replaceState(null, "", `#${id}`);
      }}
      className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium"
          : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:text-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      {label}
    </a>
  );
}

function useActiveSection(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  ids: string[],
) {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .map(e => ({ id: e.target.id, top: e.boundingClientRect.top }));
        if (visible.length === 0) return;
        visible.sort((a, b) => a.top - b.top);
        setActive(visible[0].id);
      },
      {
        root,
        rootMargin: "0px 0px -65% 0px",
        threshold: 0,
      },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [scrollRef, ids]);
  return active;
}

const UNDO_SEND_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 20, label: "20 seconds" },
  { value: 30, label: "30 seconds" },
];

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

  return (
    <section id={id} className="scroll-mt-4">
      <SectionHeader
        title="Sending"
        description="Hold outgoing messages briefly so you can undo before they leave. Cron dispatches each minute, so the actual send may follow the countdown by up to a minute."
      />
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
        <div className="mt-2 text-xs text-neutral-500 flex items-center gap-2">
          {isPending && <span>Saving…</span>}
          {!isPending && savedAt && <span>Saved</span>}
          {error && <span className="text-red-600">{error}</span>}
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

function AddDomainForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter a domain");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setName("");
      router.refresh();
    });
  }

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
