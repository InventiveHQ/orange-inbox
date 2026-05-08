"use client";

import { useEffect, useState, useTransition } from "react";

interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "member" | "reader";
  created_at: number;
}

const ROLES: Member["role"][] = ["owner", "member", "reader"];

export default function ManageMembersDialog({
  mailboxId,
  mailboxLabel,
  onClose,
}: {
  mailboxId: string;
  mailboxLabel: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Member["role"]>("member");
  const [actionError, setActionError] = useState<string | null>(null);
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
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailboxId]);

  function invite() {
    setActionError(null);
    if (!inviteEmail.trim()) return;
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <div>
            <div className="text-sm font-medium">Manage members</div>
            <div className="text-xs text-neutral-500">{mailboxLabel}</div>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="overflow-y-auto">
          {loadError && <div className="px-4 py-3 text-sm text-red-600">{loadError}</div>}
          {members === null && !loadError && (
            <div className="px-4 py-3 text-sm text-neutral-500">Loading…</div>
          )}
          {members && members.length === 0 && (
            <div className="px-4 py-3 text-sm text-neutral-500">No members yet.</div>
          )}
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {members?.map(m => (
              <li key={m.user_id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm truncate">{m.display_name || m.email}</div>
                  {m.display_name && (
                    <div className="text-xs text-neutral-500 truncate">{m.email}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs uppercase tracking-wider text-neutral-500">{m.role}</span>
                  <button
                    type="button"
                    onClick={() => remove(m.user_id)}
                    disabled={isPending}
                    className="text-xs text-red-600 hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 space-y-2">
          <div className="text-xs uppercase tracking-wider text-neutral-500">Invite</div>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="email@example.com"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") invite();
              }}
              className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as Member["role"])}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm"
            >
              {ROLES.map(r => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={invite}
              disabled={isPending}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Invite
            </button>
          </div>
          {actionError && <div className="text-xs text-red-600">{actionError}</div>}
        </div>
      </div>
    </div>
  );
}
