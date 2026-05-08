"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ContactWithMailbox } from "@/lib/contacts";
import type { Identity } from "@/lib/identities";

interface Props {
  contacts: ContactWithMailbox[];
  // Mailboxes the user can SEND from — only those can host new contacts.
  identities: Identity[];
  // Initial mailbox filter ("all" or a mailbox id).
  filter: string;
}

// Client-side controller for the contacts page. Server provides the initial
// list filtered by the URL param; this component handles in-page CRUD without
// reloading by calling /api/contacts and then router.refresh().
export default function ContactsManager({ contacts, identities, filter }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<ContactWithMailbox | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "all") return contacts;
    return contacts.filter(c => c.mailbox_id === filter);
  }, [contacts, filter]);

  function setFilter(next: string) {
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("mailbox");
    else url.searchParams.set("mailbox", next);
    router.push(`${url.pathname}?${url.searchParams.toString()}`);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">Contacts</h1>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm px-2 py-1"
          >
            <option value="all">All mailboxes</option>
            {identities.map(i => (
              <option key={i.mailbox_id} value={i.mailbox_id}>
                {i.local_part}@{i.domain_name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={identities.length === 0}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          New contact
        </button>
      </header>

      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 px-6 text-center">
          No contacts in this view yet. They&apos;ll be added automatically when you send mail.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {filtered.map(c => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 px-6 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium truncate">
                    {c.name ?? c.email}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {c.scope}
                  </span>
                </div>
                {c.name && (
                  <div className="text-sm text-neutral-700 dark:text-neutral-300 truncate">
                    {c.email}
                  </div>
                )}
                <div className="text-xs text-neutral-500">
                  {c.local_part}@{c.domain_name} · sent {c.send_count} ·{" "}
                  {c.last_seen_at ? new Date(c.last_seen_at * 1000).toLocaleDateString() : "—"}
                </div>
                {c.notes && (
                  <div className="text-xs text-neutral-500 mt-0.5 line-clamp-2">
                    {c.notes}
                  </div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  Edit
                </button>
                <DeleteContactButton id={c.id} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <ContactDialog
          identities={identities}
          defaultMailboxId={filter !== "all" ? filter : identities[0]?.mailbox_id ?? ""}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <ContactDialog
          identities={identities}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function DeleteContactButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function doDelete() {
    startTransition(async () => {
      const res = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
      setConfirming(false);
    });
  }
  if (confirming) {
    return (
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={doDelete}
          disabled={isPending}
          className="rounded-md bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Confirm"}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
    >
      Delete
    </button>
  );
}

function ContactDialog({
  identities,
  editing,
  defaultMailboxId,
  onClose,
}: {
  identities: Identity[];
  editing?: ContactWithMailbox;
  defaultMailboxId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [mailboxId, setMailboxId] = useState(
    editing?.mailbox_id ?? defaultMailboxId ?? identities[0]?.mailbox_id ?? "",
  );
  const [email, setEmail] = useState(editing?.email ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [shared, setShared] = useState(editing ? editing.scope === "shared" : true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = editing
        ? await fetch(`/api/contacts/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name || null, notes: notes || null, email }),
          })
        : await fetch("/api/contacts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mailbox_id: mailboxId,
              email,
              name: name || null,
              notes: notes || null,
              shared,
            }),
          });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium">
          {editing ? "Edit contact" : "New contact"}
        </header>
        <div className="px-4 py-3 space-y-3 text-sm">
          {!editing && (
            <Row label="Mailbox">
              <select
                value={mailboxId}
                onChange={e => setMailboxId(e.target.value)}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
              >
                {identities.map(i => (
                  <option key={i.mailbox_id} value={i.mailbox_id}>
                    {i.local_part}@{i.domain_name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row label="Email">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
            />
          </Row>
          <Row label="Name">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
            />
          </Row>
          <Row label="Notes">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 resize-none"
            />
          </Row>
          {!editing && (
            <Row label="Visibility">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={e => setShared(e.target.checked)}
                />
                <span>Shared with everyone on this mailbox</span>
              </label>
            </Row>
          )}
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="rounded-md bg-[var(--color-brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-neutral-500 w-20 shrink-0">
        {label}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
