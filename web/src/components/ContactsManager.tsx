"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CONTACT_STAGES,
  type ContactStage,
  type ContactWithMailbox,
} from "@/lib/contacts";
import type { Identity } from "@/lib/identities";
import ContactStageBadge from "./ContactStageBadge";
import ContactTagPills from "./ContactTagPills";
import EmptyState from "./EmptyState";
import { useContactsUI } from "./ContactsUIContext";

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
//
// Filter rows (Mailbox / Stage / Tag) live in the global Sidebar's
// section drawer (ContactsSidebarBody) — state is shared via
// ContactsUIContext so this component still owns the actual list-
// filtering logic.
export default function ContactsManager({ contacts, identities, filter }: Props) {
  const searchParams = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { stageFilter, tagFilter, setAllTags } = useContactsUI();

  // Search query — when the global SearchBar is on "contacts" mode it routes
  // `?q=` to this page. We filter in-memory by name / email / company / notes.
  const searchQuery = (searchParams.get("q") ?? "").trim().toLowerCase();

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of contacts) for (const t of c.tags) s.add(t);
    return Array.from(s).sort();
  }, [contacts]);

  // Push the derived tag list up to the context so the drawer can hide
  // the Tag filter group when no contact has any tag.
  useEffect(() => {
    setAllTags(allTags);
  }, [allTags, setAllTags]);

  // "+ New contact" button in the Sidebar dispatches this — the modal
  // lives here, so we listen for it and open the create dialog.
  useEffect(() => {
    function onNew() {
      if (identities.length > 0) setCreating(true);
    }
    window.addEventListener("orange:contacts:new-contact", onNew);
    return () => window.removeEventListener("orange:contacts:new-contact", onNew);
  }, [identities.length]);

  const filtered = useMemo(() => {
    return contacts.filter(c => {
      if (filter !== "all" && c.mailbox_id !== filter) return false;
      if (stageFilter === "none" && c.stage !== null) return false;
      if (stageFilter !== "all" && stageFilter !== "none" && c.stage !== stageFilter) return false;
      if (tagFilter !== "all" && !c.tags.includes(tagFilter)) return false;
      if (searchQuery) {
        const hay = [
          c.email,
          c.name ?? "",
          c.company ?? "",
          c.notes ?? "",
          ...c.tags,
        ]
          .join("\n")
          .toLowerCase();
        if (!hay.includes(searchQuery)) return false;
      }
      return true;
    });
  }, [contacts, filter, stageFilter, tagFilter, searchQuery]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Contacts</h1>
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
        contacts.length === 0 ? (
          <EmptyState variant="contacts" />
        ) : (
          // Filter / search yielded nothing — use the "search" variant so the
          // illustration carries the magnifier-on-envelope cue.
          <EmptyState
            variant="search"
            title="No contacts match"
            body="Try different keywords or clear your filters."
          />
        )
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {filtered.map(c => (
            <li
              key={c.id}
              className="hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
            >
              <Link
                href={`/inbox/contacts/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">
                      {c.name ?? c.email}
                    </span>
                    {c.stage && <ContactStageBadge stage={c.stage} />}
                    <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                      {c.scope}
                    </span>
                  </div>
                  {c.name && (
                    <div className="text-sm text-neutral-700 dark:text-neutral-300 truncate">
                      {c.email}
                    </div>
                  )}
                  {(c.company || c.title) && (
                    <div className="text-xs text-neutral-600 dark:text-neutral-400 truncate">
                      {[c.title, c.company].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  {c.tags.length > 0 && (
                    <div className="mt-1">
                      <ContactTagPills tags={c.tags} />
                    </div>
                  )}
                  <div className="text-xs text-neutral-500 mt-0.5">
                    {c.local_part}@{c.domain_name} · sent {c.send_count} ·{" "}
                    {c.last_seen_at ? new Date(c.last_seen_at * 1000).toLocaleDateString() : "—"}
                  </div>
                </div>
              </Link>
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
    </div>
  );
}

export function stageLabel(s: ContactStage): string {
  switch (s) {
    case "lead":       return "Lead";
    case "contacted":  return "Contacted";
    case "qualified":  return "Qualified";
    case "customer":   return "Customer";
    case "lost":       return "Lost";
  }
}

// Reused by the detail page for inline edits.
export function ContactDialog({
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
  const [company, setCompany] = useState(editing?.company ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const [website, setWebsite] = useState(editing?.website ?? "");
  const [linkedin, setLinkedin] = useState(editing?.linkedin ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [stage, setStage] = useState<ContactStage | "">(editing?.stage ?? "");
  const [tagsText, setTagsText] = useState(editing?.tags.join(", ") ?? "");
  const [shared, setShared] = useState(editing ? editing.scope === "shared" : true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    const tags = tagsText
      .split(",")
      .map(t => t.trim())
      .filter(t => t.length > 0);
    const payload = {
      name: name || null,
      notes: notes || null,
      company: company || null,
      title: title || null,
      phone: phone || null,
      website: website || null,
      linkedin: linkedin || null,
      address: address || null,
      stage: stage || null,
      tags,
    };
    startTransition(async () => {
      const res = editing
        ? await fetch(`/api/contacts/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, email }),
          })
        : await fetch("/api/contacts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...payload,
              mailbox_id: mailboxId,
              email,
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
        className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden flex flex-col max-h-[90vh]"
      >
        <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium">
          {editing ? "Edit contact" : "New contact"}
        </header>
        <div className="px-4 py-3 space-y-3 text-sm overflow-y-auto">
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
            <TextInput type="email" value={email} onChange={setEmail} />
          </Row>
          <Row label="Name">
            <TextInput value={name} onChange={setName} />
          </Row>
          <Row label="Company">
            <TextInput value={company} onChange={setCompany} />
          </Row>
          <Row label="Title">
            <TextInput value={title} onChange={setTitle} />
          </Row>
          <Row label="Stage">
            <select
              value={stage}
              onChange={e => setStage(e.target.value as ContactStage | "")}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
            >
              <option value="">— none —</option>
              {CONTACT_STAGES.map(s => (
                <option key={s} value={s}>{stageLabel(s)}</option>
              ))}
            </select>
          </Row>
          <Row label="Tags">
            <TextInput
              value={tagsText}
              onChange={setTagsText}
              placeholder="comma, separated"
            />
          </Row>
          <Row label="Phone">
            <TextInput value={phone} onChange={setPhone} />
          </Row>
          <Row label="Website">
            <TextInput value={website} onChange={setWebsite} placeholder="https://" />
          </Row>
          <Row label="LinkedIn">
            <TextInput value={linkedin} onChange={setLinkedin} placeholder="https://linkedin.com/in/..." />
          </Row>
          <Row label="Address">
            <textarea
              value={address}
              onChange={e => setAddress(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 resize-none"
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

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
    />
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
