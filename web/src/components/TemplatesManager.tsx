"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TemplateRow } from "@/lib/templates";
import type { Identity } from "@/lib/identities";
import { htmlToText } from "@/lib/html-text";
import RichTextEditor from "./RichTextEditor";

interface Props {
  templates: TemplateRow[];
  identities: Identity[];
}

const PLACEHOLDER_HINT =
  "Available placeholders: {{recipient_name}}, {{recipient_email}}, {{my_name}}, {{my_email}}, {{date}}, {{subject}}";

export default function TemplatesManager({ templates, identities }: Props) {
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Templates</h1>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white"
        >
          New template
        </button>
      </header>

      {templates.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 px-6 text-center">
          No templates yet. Create one and it&apos;ll appear in the compose window.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {templates.map(t => (
            <li
              key={t.id}
              className="flex items-start justify-between gap-3 px-4 py-3 sm:px-6 hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium truncate">{t.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {t.scope === "personal"
                      ? "personal"
                      : `shared · ${t.local_part}@${t.domain_name}`}
                  </span>
                </div>
                {t.subject_template && (
                  <div className="text-xs text-neutral-500 truncate">
                    Subject: {t.subject_template}
                  </div>
                )}
                <div className="text-xs text-neutral-700 dark:text-neutral-300 line-clamp-2 whitespace-pre-wrap">
                  {htmlToText(t.body_template)}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  Edit
                </button>
                <DeleteTemplateButton id={t.id} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <TemplateDialog identities={identities} onClose={() => setCreating(false)} />
      )}
      {editing && (
        <TemplateDialog
          identities={identities}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function DeleteTemplateButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function doDelete() {
    startTransition(async () => {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
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

function TemplateDialog({
  identities,
  editing,
  onClose,
}: {
  identities: Identity[];
  editing?: TemplateRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(editing?.name ?? "");
  const [subjectTemplate, setSubjectTemplate] = useState(editing?.subject_template ?? "");
  const [bodyTemplate, setBodyTemplate] = useState(editing?.body_template ?? "");
  const [scope, setScope] = useState<"personal" | "shared">(
    editing?.scope ?? (identities.length > 0 ? "personal" : "personal"),
  );
  const [mailboxId, setMailboxId] = useState(
    editing?.mailbox_id ?? identities[0]?.mailbox_id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = editing
        ? await fetch(`/api/templates/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              subject_template: subjectTemplate || null,
              body_template: bodyTemplate,
            }),
          })
        : await fetch("/api/templates", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              scope,
              mailbox_id: scope === "shared" ? mailboxId : null,
              subject_template: subjectTemplate || null,
              body_template: bodyTemplate,
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
        className="w-full max-w-lg rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium">
          {editing ? "Edit template" : "New template"}
        </header>
        <div className="px-4 py-3 space-y-3 text-sm">
          <Row label="Name">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
            />
          </Row>
          {!editing && (
            <Row label="Scope">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="scope"
                    value="personal"
                    checked={scope === "personal"}
                    onChange={() => setScope("personal")}
                  />
                  <span>Personal</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="scope"
                    value="shared"
                    checked={scope === "shared"}
                    onChange={() => setScope("shared")}
                    disabled={identities.length === 0}
                  />
                  <span>Shared on…</span>
                </label>
                {scope === "shared" && (
                  <select
                    value={mailboxId}
                    onChange={e => setMailboxId(e.target.value)}
                    className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
                  >
                    {identities.map(i => (
                      <option key={i.mailbox_id} value={i.mailbox_id}>
                        {i.local_part}@{i.domain_name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </Row>
          )}
          <Row label="Subject">
            <input
              type="text"
              value={subjectTemplate}
              onChange={e => setSubjectTemplate(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1"
            />
          </Row>
          <Row label="Body">
            <div className="rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden">
              <RichTextEditor
                initialHtml={editing?.body_template ?? ""}
                placeholder="Write the template body…"
                minHeight={180}
                onChange={html => setBodyTemplate(html)}
              />
            </div>
          </Row>
          <div className="text-[11px] text-neutral-500">{PLACEHOLDER_HINT}</div>
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
