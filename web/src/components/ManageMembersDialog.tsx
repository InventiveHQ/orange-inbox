"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MailboxRow } from "@/lib/queries";

interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "member" | "reader";
  created_at: number;
}

const ROLES: Member["role"][] = ["owner", "member", "reader"];

export default function ManageMembersDialog({
  mailbox,
  onClose,
}: {
  mailbox: MailboxRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const mailboxId = mailbox.id;
  const initialLabel = mailbox.is_catch_all
    ? `${mailbox.local_part}@ (catch-all)`
    : `${mailbox.local_part}@${mailbox.domain_name}`;

  // Settings form (rename / display name / catch-all). Pre-populated from
  // the row the sidebar already loaded; saved values are kept in local
  // state until router.refresh() pushes the new sidebar data through.
  const [localPart, setLocalPart] = useState(mailbox.local_part);
  const [displayName, setDisplayName] = useState(mailbox.display_name ?? "");
  const [isCatchAll, setIsCatchAll] = useState(mailbox.is_catch_all === 1);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Member["role"]>("member");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );

  // Esc + focus trap. Confines Tab/Shift+Tab to focusable descendants of the
  // dialog so keyboard users can't escape into the obscured background, and
  // returns focus to the opener on close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && active === last) {
        first.focus();
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey);
    // Move initial focus into the dialog so Tab/Shift+Tab cycle within it.
    const root = dialogRef.current;
    if (root) {
      const firstFocusable = root.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      firstFocusable?.focus();
    }
    const opener = openerRef.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

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

  function saveSettings() {
    setSettingsError(null);
    setSettingsSaved(false);
    const payload: Record<string, unknown> = {};
    const lp = localPart.trim().toLowerCase();
    if (lp !== mailbox.local_part) payload.local_part = lp;
    const dn = displayName.trim();
    if (dn !== (mailbox.display_name ?? "")) payload.display_name = dn || null;
    if ((mailbox.is_catch_all === 1) !== isCatchAll) payload.is_catch_all = isCatchAll;
    if (Object.keys(payload).length === 0) {
      setSettingsError("Nothing changed");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${mailboxId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setSettingsError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setSettingsSaved(true);
      router.refresh();
    });
  }

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

  function deleteMailbox() {
    if (
      !confirm(
        `Delete ${initialLabel}? All threads, messages, and attachments in it will be permanently removed.`,
      )
    ) {
      return;
    }
    setActionError(null);
    startTransition(async () => {
      const res = await fetch(`/api/mailboxes/${mailboxId}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
      router.push("/inbox/all");
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <div>
            <div id={titleId} className="text-sm font-medium">Manage mailbox</div>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">{initialLabel}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-1 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 text-xl leading-none"
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>

        <div className="overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {/* Settings */}
          <section className="px-4 py-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">Settings</div>
            <label className="block text-sm">
              <span className="text-xs text-neutral-600 dark:text-neutral-400">Address</span>
              <div className="mt-1 flex items-center gap-1">
                <input
                  type="text"
                  value={localPart}
                  onChange={e => {
                    setLocalPart(e.target.value);
                    setSettingsSaved(false);
                  }}
                  className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 focus:outline-none focus:border-[var(--color-brand)]"
                />
                <span className="text-neutral-600 dark:text-neutral-400 px-1">@{mailbox.domain_name}</span>
              </div>
            </label>
            <label className="block text-sm">
              <span className="text-xs text-neutral-600 dark:text-neutral-400">Display name (optional)</span>
              <input
                type="text"
                value={displayName}
                onChange={e => {
                  setDisplayName(e.target.value);
                  setSettingsSaved(false);
                }}
                placeholder="Support Team"
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 focus:outline-none focus:border-[var(--color-brand)]"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={isCatchAll}
                onChange={e => {
                  setIsCatchAll(e.target.checked);
                  setSettingsSaved(false);
                }}
              />
              <span>
                Catch-all{" "}
                <span className="text-xs text-neutral-600 dark:text-neutral-400">
                  — receive mail addressed to anything else on this domain
                </span>
              </span>
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              {settingsError && <span role="alert" className="text-xs text-red-700 dark:text-red-400">{settingsError}</span>}
              {settingsSaved && !settingsError && <span className="text-xs text-green-700 dark:text-green-400">Saved</span>}
              <button
                type="button"
                onClick={saveSettings}
                disabled={isPending}
                className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </section>

          {/* Members */}
          <section className="px-4 py-3">
            <div className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400 mb-1">Members</div>
            {loadError && <div role="alert" className="text-sm text-red-700 dark:text-red-400">{loadError}</div>}
            {members === null && !loadError && (
              <div className="text-sm text-neutral-600 dark:text-neutral-400">Loading…</div>
            )}
            {members && members.length === 0 && (
              <div className="text-sm text-neutral-600 dark:text-neutral-400">No members yet.</div>
            )}
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {members?.map(m => (
                <li key={m.user_id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm truncate">{m.display_name || m.email}</div>
                    {m.display_name && (
                      <div className="text-xs text-neutral-600 dark:text-neutral-400 truncate">{m.email}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">{m.role}</span>
                    <button
                      type="button"
                      onClick={() => remove(m.user_id)}
                      disabled={isPending}
                      aria-label={`Remove ${m.display_name || m.email}`}
                      className="text-xs text-red-700 dark:text-red-400 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Invite */}
          <section className="px-4 py-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">Invite</div>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="email@example.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") invite();
                }}
                aria-label="Invite email address"
                className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as Member["role"])}
                aria-label="Invite role"
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
            {actionError && <div role="alert" className="text-xs text-red-700 dark:text-red-400">{actionError}</div>}
          </section>
        </div>

        <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 flex justify-end">
          <button
            type="button"
            onClick={deleteMailbox}
            disabled={isPending}
            className="text-xs text-red-700 dark:text-red-400 hover:underline disabled:opacity-50"
          >
            Delete this mailbox
          </button>
        </div>
      </div>
    </div>
  );
}
