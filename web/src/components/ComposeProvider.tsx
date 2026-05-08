"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type { Identity } from "@/lib/identities";
import type { ContactRow } from "@/lib/contacts";
import type { TemplateRow } from "@/lib/templates";

export interface ComposeOpenArgs {
  replyToMessageId?: string;
  preferredMailboxId?: string;
  preferredScope?: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  subject?: string;
  bodyPrefill?: string;
  // If present, edits/sends update this draft and delete it on send.
  draftId?: string;
}

interface ComposeCtx {
  open: (args?: ComposeOpenArgs) => void;
}

const Ctx = createContext<ComposeCtx | null>(null);

export function useCompose(): ComposeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCompose must be inside ComposeProvider");
  return c;
}

export default function ComposeProvider({
  identities,
  children,
}: {
  identities: Identity[];
  children: React.ReactNode;
}) {
  const [args, setArgs] = useState<ComposeOpenArgs | null>(null);
  // Bumped every time we want to *replace* the in-flight compose with a fresh
  // one (e.g. a Reply click). The modal keys off this so its internal state
  // (to/cc/subject/body) is reset cleanly without lifting it into the provider.
  const [instanceKey, setInstanceKey] = useState(0);

  const open = useCallback((a?: ComposeOpenArgs) => {
    setArgs(a ?? {});
    setInstanceKey(k => k + 1);
  }, []);

  const ctx = useMemo<ComposeCtx>(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {args !== null && (
        <ComposeModal
          key={instanceKey}
          identities={identities}
          args={args}
          onClose={() => setArgs(null)}
        />
      )}
    </Ctx.Provider>
  );
}

function ComposeModal({
  identities,
  args,
  onClose,
}: {
  identities: Identity[];
  args: ComposeOpenArgs;
  onClose: () => void;
}) {
  const router = useRouter();
  const initial = useMemo(() => pickInitialIdentity(identities, args), [identities, args]);
  const [fromId, setFromId] = useState(initial?.mailbox_id ?? "");
  const [to, setTo] = useState((args.toAddrs ?? []).join(", "));
  const [cc, setCc] = useState((args.ccAddrs ?? []).join(", "));
  const [showCc, setShowCc] = useState((args.ccAddrs ?? []).length > 0);
  const [subject, setSubject] = useState(args.subject ?? "");
  const [body, setBody] = useState(args.bodyPrefill ?? "");
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(args.draftId ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [isSending, startSending] = useTransition();
  const [isSavingDraft, startSavingDraft] = useTransition();

  const fromIdentity = useMemo(
    () => identities.find(i => i.mailbox_id === fromId),
    [identities, fromId],
  );

  if (identities.length === 0) {
    return (
      <ModalShell onBackdrop={onClose}>
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          You don&apos;t have access to any mailbox yet. Add a mail domain from the sidebar
          first.
        </div>
        <div className="px-4 pb-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Close
          </button>
        </div>
      </ModalShell>
    );
  }

  const hasContent =
    to.trim() !== "" ||
    cc.trim() !== "" ||
    subject.trim() !== "" ||
    body.trim() !== "";

  function payload() {
    return {
      mailbox_id: fromId,
      to: splitList(to),
      cc: splitList(cc),
      subject,
      body,
      reply_to_message_id: args.replyToMessageId ?? null,
    };
  }

  function saveDraft() {
    if (!hasContent) {
      setError("Nothing to save yet");
      return;
    }
    setError(null);
    startSavingDraft(async () => {
      const res = draftId
        ? await fetch(`/api/drafts/${draftId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload()),
          })
        : await fetch("/api/drafts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload()),
          });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Save failed (${res.status})`);
        return;
      }
      if (!draftId) {
        const b = (await res.json().catch(() => ({}))) as { id?: string };
        if (b.id) setDraftId(b.id);
      }
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  function submit() {
    setError(null);
    const toList = splitList(to);
    const ccList = splitList(cc);
    if (toList.length === 0) {
      setError("Add at least one recipient");
      return;
    }
    if (!body.trim()) {
      setError("Body can't be empty");
      return;
    }

    startSending(async () => {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from_mailbox_id: fromId,
          to: toList,
          cc: ccList.length ? ccList : undefined,
          subject,
          body,
          reply_to_message_id: args.replyToMessageId,
          draft_id: draftId ?? undefined,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Send failed (${res.status})`);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function tryDiscard() {
    if (hasContent && !confirmingDiscard) {
      setConfirmingDiscard(true);
      return;
    }
    if (draftId) {
      // Best-effort delete — we close either way.
      void fetch(`/api/drafts/${draftId}`, { method: "DELETE" }).then(() => router.refresh());
    }
    onClose();
  }

  function applyTemplate(t: TemplateRow) {
    const ctx: TemplateContext = {
      recipientEmail: splitList(to)[0] ?? "",
      myName: fromIdentity?.display_name ?? null,
      myEmail: fromIdentity
        ? `${fromIdentity.local_part}@${fromIdentity.domain_name}`
        : "",
      subject,
    };
    if (t.subject_template) setSubject(fillTemplate(t.subject_template, ctx));
    setBody(prev => {
      const filled = fillTemplate(t.body_template, ctx);
      return prev.trim() ? `${prev}\n\n${filled}` : filled;
    });
  }

  if (minimized) {
    return (
      <MinimizedBar
        title={subject || (args.replyToMessageId ? "Reply" : "New message")}
        onRestore={() => setMinimized(false)}
        onClose={tryDiscard}
        confirmingDiscard={confirmingDiscard}
        cancelDiscard={() => setConfirmingDiscard(false)}
      />
    );
  }

  return (
    <ModalShell onBackdrop={() => setMinimized(true)}>
      <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-sm font-medium">
          {args.replyToMessageId ? "Reply" : draftId ? "Draft" : "New message"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMinimized(true)}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 px-1.5 leading-none"
            aria-label="Minimize"
            title="Minimize"
          >
            —
          </button>
          <button
            type="button"
            onClick={tryDiscard}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none px-1"
            aria-label="Close"
            title={hasContent ? "Discard" : "Close"}
          >
            ×
          </button>
        </div>
      </header>

      <div className="px-4 py-2 space-y-2 text-sm">
        <Field label="From">
          <select
            value={fromId}
            onChange={e => setFromId(e.target.value)}
            className="w-full bg-transparent border-none focus:outline-none"
          >
            {identities.map(i => (
              <option key={i.mailbox_id} value={i.mailbox_id}>
                {i.display_name ? `${i.display_name} <${i.local_part}@${i.domain_name}>` : `${i.local_part}@${i.domain_name}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <RecipientInput
            value={to}
            onChange={setTo}
            mailboxId={fromId}
            placeholder="comma-separated addresses"
          />
          {!showCc && (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="ml-2 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              + Cc
            </button>
          )}
        </Field>
        {showCc && (
          <Field label="Cc">
            <RecipientInput value={cc} onChange={setCc} mailboxId={fromId} />
          </Field>
        )}
        <Field label="Subject">
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className="w-full bg-transparent border-none focus:outline-none"
          />
        </Field>
      </div>

      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={12}
        placeholder="Write your message…"
        className="block w-full px-4 py-3 bg-transparent border-t border-neutral-200 dark:border-neutral-800 focus:outline-none resize-none text-sm leading-relaxed"
      />

      {error && (
        <div className="px-4 py-2 text-xs text-red-600 border-t border-neutral-200 dark:border-neutral-800">
          {error}
        </div>
      )}

      {confirmingDiscard && (
        <div className="px-4 py-3 text-xs border-t border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700/60 flex items-center justify-between gap-3">
          <span className="text-amber-900 dark:text-amber-200">
            Discard this draft? Unsaved content will be lost.
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDiscard(false)}
              className="rounded-md px-2 py-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={tryDiscard}
              className="rounded-md bg-red-600 px-2 py-1 text-white hover:bg-red-700"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <TemplatePicker onPick={applyTemplate} />
          <span className="text-xs text-neutral-500">
            {isSavingDraft
              ? "Saving…"
              : savedAt
                ? `Draft saved ${formatRelative(savedAt)}`
                : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={tryDiscard}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={saveDraft}
            disabled={isSavingDraft || !hasContent}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isSending}
            className="rounded-md bg-[var(--color-brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </footer>
    </ModalShell>
  );
}

// ─── Recipient typeahead ────────────────────────────────────────────────────
//
// A controlled text input that operates on a comma-separated list. The input
// surfaces a dropdown of contact suggestions matching the *trailing* token —
// picking one replaces only that token and appends a separator so the user
// can keep typing the next address. Search is scoped to the currently-chosen
// From mailbox, debounced, and falls back to the recent-contacts list when
// the trailing token is empty.

function RecipientInput({
  value,
  onChange,
  mailboxId,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  mailboxId: string;
  placeholder?: string;
}) {
  const [results, setResults] = useState<ContactRow[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const trailing = trailingToken(value);
  // Debounce search to avoid hammering the API on every keystroke.
  useEffect(() => {
    if (!open || !mailboxId) return;
    const handle = setTimeout(async () => {
      try {
        const url = new URL("/api/contacts/search", window.location.origin);
        url.searchParams.set("mailbox_id", mailboxId);
        if (trailing) url.searchParams.set("q", trailing);
        const res = await fetch(url.toString());
        if (!res.ok) return;
        const j = (await res.json()) as { contacts?: ContactRow[] };
        setResults(j.contacts ?? []);
        setHighlight(0);
      } catch {
        // network hiccup — silently swallow; the input still works as plain text.
      }
    }, 120);
    return () => clearTimeout(handle);
  }, [trailing, mailboxId, open]);

  // Close the dropdown when clicking outside the wrapper.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(c: ContactRow) {
    onChange(replaceTrailingToken(value, c.email));
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(h => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <input
        type="text"
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="w-full bg-transparent border-none focus:outline-none"
      />
      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full mt-1 z-10 max-h-56 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg text-sm">
          {results.map((c, idx) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={e => {
                  // mousedown so the input doesn't lose focus before we pick.
                  e.preventDefault();
                  pick(c);
                }}
                className={`w-full text-left px-3 py-1.5 ${
                  idx === highlight
                    ? "bg-neutral-100 dark:bg-neutral-900"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">
                    {c.name ? (
                      <>
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-neutral-500">&lt;{c.email}&gt;</span>
                      </>
                    ) : (
                      c.email
                    )}
                  </span>
                  {c.scope === "personal" && (
                    <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                      personal
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Template picker ────────────────────────────────────────────────────────

function TemplatePicker({ onPick }: { onPick: (t: TemplateRow) => void }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || templates !== null) return;
    void (async () => {
      try {
        const res = await fetch("/api/templates");
        if (!res.ok) return;
        const j = (await res.json()) as { templates?: TemplateRow[] };
        setTemplates(j.templates ?? []);
      } catch {
        setTemplates([]);
      }
    })();
  }, [open, templates]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        Insert template ▾
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-10 w-72 max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg">
          {templates === null && (
            <div className="px-3 py-2 text-sm text-neutral-500">Loading…</div>
          )}
          {templates !== null && templates.length === 0 && (
            <div className="px-3 py-2 text-sm text-neutral-500">
              No templates yet. Manage them on the Templates page.
            </div>
          )}
          {templates && templates.length > 0 && (
            <ul className="text-sm">
              {templates.map(t => (
                <li key={t.id}>
                  <button
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault();
                      onPick(t);
                      setOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium truncate">{t.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0">
                        {t.scope === "personal"
                          ? "personal"
                          : `${t.local_part}@${t.domain_name}`}
                      </span>
                    </div>
                    {t.subject_template && (
                      <div className="text-xs text-neutral-500 truncate">
                        Subject: {t.subject_template}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ModalShell({
  onBackdrop,
  children,
}: {
  onBackdrop: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:p-6 bg-black/30"
      onClick={onBackdrop}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full sm:w-[560px] max-h-[85vh] flex flex-col rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

function MinimizedBar({
  title,
  onRestore,
  onClose,
  confirmingDiscard,
  cancelDiscard,
}: {
  title: string;
  onRestore: () => void;
  onClose: () => void;
  confirmingDiscard: boolean;
  cancelDiscard: () => void;
}) {
  // No backdrop — the page stays interactive while minimized. The bar pins to
  // the bottom-right; clicking the title restores the full modal.
  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg bg-white dark:bg-neutral-950 shadow-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onRestore}
          className="flex-1 truncate text-left text-sm font-medium px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          title="Restore"
        >
          {title}
        </button>
        <button
          type="button"
          onClick={onRestore}
          className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 px-2 leading-none"
          aria-label="Restore"
          title="Restore"
        >
          ▢
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none px-2"
          aria-label="Close"
          title="Discard"
        >
          ×
        </button>
      </div>
      {confirmingDiscard && (
        <div className="px-3 py-2 text-xs border-t border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700/60 flex items-center justify-between gap-2">
          <span className="text-amber-900 dark:text-amber-200">Discard draft?</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={cancelDiscard}
              className="rounded-md px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-neutral-200 dark:border-neutral-800 py-1.5">
      <span className="text-xs uppercase tracking-wider text-neutral-500 w-14 shrink-0">{label}</span>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  );
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function trailingToken(s: string): string {
  const idx = s.lastIndexOf(",");
  return idx === -1 ? s.trim() : s.slice(idx + 1).trim();
}

function replaceTrailingToken(s: string, replacement: string): string {
  const idx = s.lastIndexOf(",");
  const prefix = idx === -1 ? "" : s.slice(0, idx + 1) + " ";
  return `${prefix}${replacement}, `;
}

function formatRelative(ts: number): string {
  const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

interface TemplateContext {
  recipientEmail: string;
  myName: string | null;
  myEmail: string;
  subject: string;
}

// Substitute a tiny set of placeholders. {{recipient_name}} falls back to
// the local-part of the address when no display name is known. We keep the
// list short and obvious — anything more elaborate (loops, conditionals)
// is a footgun for non-technical users editing canned responses.
function fillTemplate(text: string, c: TemplateContext): string {
  const recipientName = c.recipientEmail
    ? c.recipientEmail.split("@")[0]
    : "";
  const today = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const map: Record<string, string> = {
    recipient_name: recipientName,
    recipient_email: c.recipientEmail,
    my_name: c.myName ?? "",
    my_email: c.myEmail,
    date: today,
    subject: c.subject,
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m;
  });
}

// Reply: pick the mailbox that received the original. Compose from /inbox/<domain>:
// pick that domain's catch-all (or first mailbox). Otherwise: first identity.
function pickInitialIdentity(identities: Identity[], args: ComposeOpenArgs): Identity | undefined {
  if (args.preferredMailboxId) {
    const m = identities.find(i => i.mailbox_id === args.preferredMailboxId);
    if (m) return m;
  }
  if (args.preferredScope && args.preferredScope !== "all") {
    const inDomain = identities.filter(i => i.domain_name === args.preferredScope);
    if (inDomain.length > 0) {
      return inDomain.find(i => i.is_catch_all === 1) ?? inDomain[0];
    }
  }
  return identities[0];
}
