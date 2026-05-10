"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  ContactStage,
  ContactThreadRow,
  ContactWithMailbox,
} from "@/lib/contacts";
import type { Identity } from "@/lib/identities";
import { ContactDialog, stageLabel } from "./ContactsManager";
import ContactStageBadge from "./ContactStageBadge";
import ContactTagPills from "./ContactTagPills";
import RelativeTime from "./RelativeTime";
import { CONTACT_STAGES } from "@/lib/contacts";

// Common IANA zones offered as suggestions in the manual-override datalist.
// Not exhaustive — the input still accepts any string and we validate
// server-side via Intl.DateTimeFormat.
const COMMON_TIMEZONES: string[] = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Athens",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Pacific/Honolulu",
  "Etc/UTC",
];

function tzSourceLabel(source: ContactWithMailbox["tz_source"]): string | null {
  switch (source) {
    case "manual":    return "set manually";
    case "signature": return "inferred from signature";
    case "domain":    return "inferred from email domain";
    default:          return null;
  }
}

interface Props {
  contact: ContactWithMailbox;
  threads: ContactThreadRow[];
  identities: Identity[];
}

// Single-contact CRM view. Profile column on the left, timeline of threads
// (across every mailbox the user can read) on the right.
export default function ContactDetail({ contact, threads, identities }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isPending, startTransition] = useTransition();

  function patchStage(next: ContactStage | null) {
    startTransition(async () => {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage: next }),
      });
      if (res.ok) router.refresh();
    });
  }

  function patchTz(next: string | null) {
    startTransition(async () => {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tz: next }),
      });
      if (res.ok) router.refresh();
    });
  }

  function doDelete() {
    startTransition(async () => {
      const res = await fetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
      if (res.ok) router.push("/inbox/contacts");
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Link
            href="/inbox/contacts"
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ← Contacts
          </Link>
          <h1 className="text-base font-semibold truncate">
            {contact.name ?? contact.email}
          </h1>
          {contact.stage && <ContactStageBadge stage={contact.stage} />}
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {contact.scope}
          </span>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Edit
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doDelete}
                disabled={isPending}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isPending ? "Deleting…" : "Confirm delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
            >
              Delete
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[20rem_1fr] overflow-y-auto md:overflow-hidden">
        <aside className="md:border-r border-b md:border-b-0 border-neutral-200 dark:border-neutral-800 md:overflow-y-auto p-4 sm:p-6 space-y-5">
          <Field label="Email">
            <a
              href={`mailto:${contact.email}`}
              className="text-[var(--color-brand)] hover:underline break-all"
            >
              {contact.email}
            </a>
          </Field>
          <Field label="Stage">
            <select
              value={contact.stage ?? ""}
              onChange={e =>
                patchStage((e.target.value || null) as ContactStage | null)
              }
              disabled={isPending}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm px-2 py-1"
            >
              <option value="">— none —</option>
              {CONTACT_STAGES.map(s => (
                <option key={s} value={s}>{stageLabel(s)}</option>
              ))}
            </select>
          </Field>
          {contact.tags.length > 0 && (
            <Field label="Tags">
              <ContactTagPills tags={contact.tags} />
            </Field>
          )}
          <Field label="Time zone">
            <TimeZoneEditor
              tz={contact.tz}
              source={contact.tz_source}
              disabled={isPending}
              onChange={patchTz}
            />
          </Field>
          {contact.company && <Field label="Company">{contact.company}</Field>}
          {contact.title && <Field label="Title">{contact.title}</Field>}
          {contact.phone && (
            <Field label="Phone">
              <a href={`tel:${contact.phone}`} className="hover:underline">
                {contact.phone}
              </a>
            </Field>
          )}
          {contact.website && (
            <Field label="Website">
              <ExternalLink href={contact.website} />
            </Field>
          )}
          {contact.linkedin && (
            <Field label="LinkedIn">
              <ExternalLink href={contact.linkedin} />
            </Field>
          )}
          {contact.address && (
            <Field label="Address">
              <span className="whitespace-pre-wrap">{contact.address}</span>
            </Field>
          )}
          {contact.notes && (
            <Field label="Notes">
              <span className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
                {contact.notes}
              </span>
            </Field>
          )}
          <Field label="Mailbox">
            {contact.local_part}@{contact.domain_name}
          </Field>
          <Field label="Activity">
            <div className="text-neutral-700 dark:text-neutral-300">
              Sent {contact.send_count} · Received {contact.receive_count}
            </div>
            <div className="text-xs text-neutral-500 mt-0.5">
              First seen {fmtDate(contact.first_seen_at)} · Last{" "}
              {fmtDate(contact.last_seen_at)}
            </div>
          </Field>
        </aside>

        <section className="md:overflow-y-auto">
          <header className="px-4 py-3 sm:px-6 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium flex items-center justify-between">
            <span>Conversation history</span>
            <span className="text-xs text-neutral-500">
              {threads.length} thread{threads.length === 1 ? "" : "s"}
            </span>
          </header>
          {threads.length === 0 ? (
            <div className="px-4 py-12 sm:px-6 text-sm text-neutral-500 text-center">
              No threads with this address in mailboxes you can read.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {threads.map(t => (
                <li key={t.thread_id}>
                  <Link
                    href={`/inbox/${t.mailbox_id}/${t.thread_id}`}
                    className="block px-4 py-3 sm:px-6 hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium truncate">
                        {t.last_subject ?? t.subject_normalized ?? "(no subject)"}
                      </span>
                      <span className="text-xs text-neutral-500 shrink-0">
                        {fmtDate(t.last_message_at)}
                      </span>
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {t.mailbox_local_part}@{t.domain_name} ·{" "}
                      {t.message_count} message{t.message_count === 1 ? "" : "s"}
                      {t.unread_count > 0 && (
                        <span className="ml-1 text-[var(--color-brand)] font-medium">
                          · {t.unread_count} unread
                        </span>
                      )}
                    </div>
                    {t.last_snippet && (
                      <div className="text-sm text-neutral-600 dark:text-neutral-400 truncate mt-0.5">
                        {t.last_snippet}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing && (
        <ContactDialog
          identities={identities}
          editing={contact}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// Inline tz editor (#88). Default state is read-only with the current value
// + source annotation + RelativeTime preview. Clicking "Edit" expands a
// text input with a datalist of common IANA zones; saving routes through
// PATCH /api/contacts/<id> with `tz` set, which marks the row as
// `tz_source='manual'` so future heuristic re-scans don't overwrite it.
// Clearing the field unsets the manual override and lets inference re-run.
function TimeZoneEditor({
  tz,
  source,
  disabled,
  onChange,
}: {
  tz: string | null;
  source: ContactWithMailbox["tz_source"];
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tz ?? "");
  const sourceLabel = tzSourceLabel(source);

  if (!editing) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {tz ? (
          <>
            <span className="font-mono text-xs">{tz}</span>
            <RelativeTime tz={tz} prefix={false} source={source} />
            {sourceLabel && (
              <span className="text-[10px] text-neutral-500">
                ({sourceLabel})
              </span>
            )}
          </>
        ) : (
          <span className="text-neutral-500 italic">Not set</span>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(tz ?? "");
            setEditing(true);
          }}
          className="text-xs text-[var(--color-brand)] hover:underline"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        list="contact-tz-suggestions"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="e.g. Europe/Berlin"
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm font-mono"
      />
      <datalist id="contact-tz-suggestions">
        {COMMON_TIMEZONES.map(z => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = draft.trim();
            onChange(next === "" ? null : next);
            setEditing(false);
          }}
          className="rounded-md bg-[var(--color-brand)] px-2 py-1 text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(tz ?? "");
            setEditing(false);
          }}
          className="rounded-md px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
        {tz && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setEditing(false);
            }}
            className="rounded-md px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
            title="Clear the manual override and re-run inference"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function ExternalLink({ href }: { href: string }) {
  const url = href.startsWith("http://") || href.startsWith("https://") ? href : `https://${href}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-brand)] hover:underline break-all"
    >
      {href}
    </a>
  );
}

function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString();
}
