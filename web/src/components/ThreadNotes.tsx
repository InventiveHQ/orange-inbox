"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface NoteShape {
  id: string;
  thread_id: string;
  user_id: string;
  body: string;
  created_at: number;
  user_email: string | null;
  user_display_name: string | null;
}

interface Props {
  threadId: string;
  currentUserId: string;
  initialNotes: NoteShape[];
}

// Internal notes panel rendered inline at the top of ThreadView (above the
// message list). Distinct yellow tint + "Internal note" label so it can't be
// confused with the email thread itself. Notes never leave the inbox — they're
// not part of the outbound reply chain.
//
// Anyone with mailbox access can read every note + add a new one. Only the
// author can delete their own note.
export default function ThreadNotes({ threadId, currentUserId, initialNotes }: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState<NoteShape[]>(initialNotes);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { note: NoteShape };
      setNotes(prev => [...prev, data.note]);
      setDraft("");
      setShowCompose(false);
      router.refresh();
    });
  }

  function remove(noteId: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setNotes(prev => prev.filter(n => n.id !== noteId));
      router.refresh();
    });
  }

  const hasNotes = notes.length > 0;

  return (
    <section
      aria-label="Internal notes"
      className="border-b border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-900/15"
    >
      <div className="px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-900 dark:text-amber-300">
            Internal notes
            {hasNotes && (
              <span className="ml-2 font-normal normal-case text-amber-800/70 dark:text-amber-400/80">
                ({notes.length})
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowCompose(o => !o)}
            disabled={isPending}
            className="rounded-md border border-amber-300 dark:border-amber-900/60 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
          >
            {showCompose ? "Cancel" : "Add note"}
          </button>
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        {hasNotes && (
          <ul className="mt-3 space-y-2">
            {notes.map(n => (
              <NoteItem
                key={n.id}
                note={n}
                canDelete={n.user_id === currentUserId}
                onDelete={() => remove(n.id)}
                disabled={isPending}
              />
            ))}
          </ul>
        )}

        {showCompose && (
          <div className="mt-3 rounded-md border border-amber-300 dark:border-amber-900/60 bg-white dark:bg-neutral-900 p-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Internal note — visible to mailbox members only"
              disabled={isPending}
              className="w-full resize-y rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-50"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft("");
                  setShowCompose(false);
                }}
                disabled={isPending}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={isPending || !draft.trim()}
                className="rounded-md border border-amber-500 bg-amber-400 text-amber-950 px-3 py-1 text-xs font-medium hover:bg-amber-300 disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function NoteItem({
  note,
  canDelete,
  onDelete,
  disabled,
}: {
  note: NoteShape;
  canDelete: boolean;
  onDelete: () => void;
  disabled: boolean;
}) {
  const author = note.user_display_name?.trim() || note.user_email || "Unknown";
  return (
    <li className="rounded-md border border-amber-200 dark:border-amber-900/40 bg-white dark:bg-neutral-900 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-label="Internal note"
            title="Internal note — not sent to the sender"
            className="shrink-0 rounded-full bg-amber-200 dark:bg-amber-900/60 text-amber-900 dark:text-amber-200 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider"
          >
            Note
          </span>
          <span className="truncate text-xs font-medium">{author}</span>
          <span className="shrink-0 text-[11px] text-neutral-500">
            {formatNoteDate(note.created_at)}
          </span>
        </div>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            title="Delete note"
            className="shrink-0 text-[11px] text-neutral-500 hover:text-red-600 disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
        {note.body}
      </p>
    </li>
  );
}

function formatNoteDate(secs: number): string {
  const d = new Date(secs * 1000);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
