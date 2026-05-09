"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DomainRow } from "@/lib/queries";
import type { Identity } from "@/lib/identities";
import type { LabelRow } from "@/lib/labels";
import { APP_VERSION } from "@/lib/version";
import LabelChip from "./LabelChip";
import PushNotificationToggle from "./PushNotificationToggle";
import RichTextEditor from "./RichTextEditor";
import usePWAUpdate from "./usePWAUpdate";

interface Props {
  domains: DomainRow[];
  initialLabels: LabelRow[];
  // Mailboxes the current user can manage. For admins this is every mailbox
  // in the system; for non-admins it's empty (management UI is hidden).
  manageableIdentities: Identity[];
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

export default function SettingsManager({ domains, initialLabels, manageableIdentities, isAdmin }: Props) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 space-y-10">
          <MailDomainsSection domains={domains} isAdmin={isAdmin} />
          {isAdmin && <MailboxAccessSection identities={manageableIdentities} />}
          {isAdmin && <SignaturesSection identities={manageableIdentities} />}
          <LabelsSection initialLabels={initialLabels} />
          <NotificationsSection />
          <AboutSection />
        </div>
      </div>
    </div>
  );
}

function SignaturesSection({ identities }: { identities: Identity[] }) {
  return (
    <section>
      <SectionHeader
        title="Signatures"
        description="Per-mailbox signature appended to every outbound message."
      />
      {identities.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm text-neutral-500">
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
      const res = await fetch(`/api/mailboxes/${identity.mailbox_id}`, {
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
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800">
        <div className="text-sm font-medium truncate">
          {identity.local_part}@{identity.domain_name}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {savedAt && (
            <span className="text-xs text-neutral-500">Saved</span>
          )}
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

interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "member" | "reader";
  created_at: number;
}
const MEMBER_ROLES: Member["role"][] = ["owner", "member", "reader"];

function MailboxAccessSection({ identities }: { identities: Identity[] }) {
  // One row per mailbox in the system (admin view). Each row lazily fetches
  // its member list the first time the row mounts so the page paints fast
  // even with many mailboxes.
  return (
    <section>
      <SectionHeader
        title="Mailbox access"
        description="Invite collaborators (e.g. a contractor working on a single mailbox) and pick their role: owner, member (read + send), or reader (read-only). They sign in via Cloudflare Access — make sure your Access policy allows their email."
      />
      {identities.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm text-neutral-500">
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

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium truncate">
        {label}
      </div>

      <div className="px-3 py-2">
        {loadError && <div className="text-xs text-red-600 mb-1">{loadError}</div>}
        {members === null && !loadError && (
          <div className="text-xs text-neutral-500">Loading…</div>
        )}
        {members && members.length === 0 && (
          <div className="text-xs text-neutral-500">Just you.</div>
        )}
        {members && members.length > 0 && (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {members.map(m => (
              <li key={m.user_id} className="py-1.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm truncate">{m.display_name || m.email}</div>
                  {m.display_name && (
                    <div className="text-[11px] text-neutral-500 truncate">{m.email}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <select
                    value={m.role}
                    onChange={e => changeRole(m.user_id, e.target.value as Member["role"])}
                    disabled={isPending}
                    className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-xs px-1.5 py-0.5"
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

      <div className="px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-1.5">
        <input
          type="email"
          placeholder="contractor@example.com"
          value={inviteEmail}
          onChange={e => setInviteEmail(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") invite();
          }}
          className="flex-1 min-w-0 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        />
        <select
          value={inviteRole}
          onChange={e => setInviteRole(e.target.value as Member["role"])}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-sm"
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
        <div className="px-3 pb-2 text-xs text-red-600">{actionError}</div>
      )}
    </div>
  );
}

function MailDomainsSection({ domains, isAdmin }: { domains: DomainRow[]; isAdmin: boolean }) {
  return (
    <section>
      <SectionHeader
        title="Mail domains"
        description="Domains routed to orange-inbox. Adding a domain creates a default catch-all mailbox you own."
      />
      {domains.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm text-neutral-500">
          No domains yet.
        </div>
      ) : (
        <ul className="rounded-md border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-800 mb-4">
          {domains.map(d => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{d.name}</div>
                {d.display_name && (
                  <div className="text-xs text-neutral-500 truncate">{d.display_name}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && <AddDomainForm />}
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

function LabelsSection({ initialLabels }: { initialLabels: LabelRow[] }) {
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
    <section>
      <SectionHeader title="Labels" description="Tags you can apply to conversations." />

      {loadError && <div className="text-sm text-red-600 mb-2">{loadError}</div>}
      {labels.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm text-neutral-500 mb-4">
          No labels yet.
        </div>
      ) : (
        <ul className="rounded-md border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-800 mb-4">
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
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
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

      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-3 space-y-2">
        <div className="text-xs uppercase tracking-wider text-neutral-500">New label</div>
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
      {actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}
    </section>
  );
}

function NotificationsSection() {
  return (
    <section>
      <SectionHeader
        title="Notifications"
        description="Get a phone-style notification when new mail arrives. Subscription is per-device — turn it on once on each device you use."
      />
      <PushNotificationToggle />
    </section>
  );
}

function AboutSection() {
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
    <section>
      <SectionHeader title="About" description="" />
      <div className="rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-3 text-sm space-y-3">
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

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-neutral-500 mt-0.5">{description}</p>
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
