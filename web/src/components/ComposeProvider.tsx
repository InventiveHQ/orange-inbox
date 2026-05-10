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
import { looksLikeHtml } from "@/lib/html-text";
import RichTextEditor from "./RichTextEditor";
import UndoSendToast from "./UndoSendToast";

export interface ComposeOpenArgs {
  replyToMessageId?: string;
  preferredMailboxId?: string;
  preferredScope?: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  subject?: string;
  bodyPrefill?: string;
  // HTML for a quoted-original block appended below the signature on
  // replies, so the user can see what they're replying to without leaving
  // the compose view (matters most on mobile, where the modal is full-screen).
  quotedHtml?: string;
  // If present, edits/sends update this draft and delete it on send.
  draftId?: string;
  // Thread the reply belongs to. Used by "Send and archive" to PATCH the
  // thread archived=true after the send succeeds. No-op for new compose.
  threadId?: string;
}

interface UploadedFile {
  id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
}

interface ComposeCtx {
  open: (args?: ComposeOpenArgs) => void;
  // Identities the current user can send from. Exposed on the context so
  // reply/reply-all helpers can strip the user's own addresses from the
  // recipient list without re-fetching.
  identities: Identity[];
}

// Wrap a plain-text fragment as an HTML <p> block, preserving newlines as
// <br>. Used so legacy plain-text drafts/prefills load cleanly into the
// rich-text editor.
function plainTextToHtml(text: string): string {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Coerce arbitrary input (HTML or plain text) into HTML so it can be loaded
// into the Lexical editor uniformly.
function toHtml(input: string): string {
  if (!input) return "";
  return looksLikeHtml(input) ? input : plainTextToHtml(input);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const Ctx = createContext<ComposeCtx | null>(null);

export function useCompose(): ComposeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCompose must be inside ComposeProvider");
  return c;
}

// State for the Undo Send toast. Lives at the Provider level so the toast
// survives the compose modal closing — by design, the user hits Send (which
// closes compose) and the countdown ticks at the bottom of the screen.
interface UndoToastState {
  scheduledId: string;
  delaySeconds: number;
}

export default function ComposeProvider({
  identities,
  undoSendSeconds,
  children,
}: {
  identities: Identity[];
  // 0 = Undo Send disabled; otherwise the configured hold window in seconds.
  undoSendSeconds: number;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [args, setArgs] = useState<ComposeOpenArgs | null>(null);
  // Bumped every time we want to *replace* the in-flight compose with a fresh
  // one (e.g. a Reply click). The modal keys off this so its internal state
  // (to/cc/subject/body) is reset cleanly without lifting it into the provider.
  const [instanceKey, setInstanceKey] = useState(0);
  const [undoToast, setUndoToast] = useState<UndoToastState | null>(null);

  const open = useCallback((a?: ComposeOpenArgs) => {
    setArgs(a ?? {});
    setInstanceKey(k => k + 1);
  }, []);

  const ctx = useMemo<ComposeCtx>(() => ({ open, identities }), [open, identities]);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {args !== null && (
        <ComposeModal
          key={instanceKey}
          identities={identities}
          undoSendSeconds={undoSendSeconds}
          args={args}
          onClose={() => setArgs(null)}
          onQueuedUndoSend={(scheduledId, delaySeconds) =>
            setUndoToast({ scheduledId, delaySeconds })
          }
        />
      )}
      {undoToast && (
        <UndoSendToast
          key={undoToast.scheduledId}
          scheduledId={undoToast.scheduledId}
          delaySeconds={undoToast.delaySeconds}
          onUndone={draftId => {
            setUndoToast(null);
            // Reopen the compose modal pointing at the restored draft.
            open({ draftId });
            router.refresh();
          }}
          onDismiss={() => setUndoToast(null)}
        />
      )}
    </Ctx.Provider>
  );
}

function ComposeModal({
  identities,
  undoSendSeconds,
  args,
  onClose,
  onQueuedUndoSend,
}: {
  identities: Identity[];
  undoSendSeconds: number;
  args: ComposeOpenArgs;
  onClose: () => void;
  onQueuedUndoSend: (scheduledId: string, delaySeconds: number) => void;
}) {
  const router = useRouter();
  const initial = useMemo(() => pickInitialIdentity(identities, args), [identities, args]);
  // Initial body (HTML) = prefill HTML + the chosen identity's signature
  // separator + signature_html, with an optional quoted-original block
  // appended on replies. Body state is only seeded once — switching
  // From mid-compose won't swap the signature (v1 limitation).
  const initialBodyHtml = useMemo(() => {
    const prefillHtml = toHtml(args.bodyPrefill ?? "");
    const sig = initial?.signature_html ?? "";
    const quoted = args.quotedHtml ?? "";

    if (quoted) {
      // Reply layout: cursor para → signature → quoted original.
      const head = prefillHtml || "<p><br></p>";
      const sigBlock = sig ? `<p>-- </p>${sig}` : "";
      return `${head}${sigBlock}<p><br></p>${quoted}`;
    }

    if (!sig) return prefillHtml;
    const sepAndSig = `<p>-- </p>${sig}`;
    return prefillHtml ? `${prefillHtml}<p><br></p>${sepAndSig}` : `<p><br></p>${sepAndSig}`;
  }, [args.bodyPrefill, args.quotedHtml, initial]);

  // The composer dropdown keys off Identity.id ("<mailbox_id>" for mailboxes,
  // "alias:<id>" for promoted aliases) so a single <select> covers both
  // kinds without colliding. The send call resolves it back to a mailbox_id
  // and (optional) sendAsAliasId before hitting the API.
  //
  // Initial value: localStorage cache wins for compose-to-known-recipient
  // (so promoting one alias and using it once locks in the From for next
  // time without a server round-trip), then the standard "preferred mailbox
  // / first identity" fallback. The reply-time auto-detect runs after
  // mount via a useEffect against /api/messages/<id>/recipients.
  const composeIdentityCacheKey = "orange-compose-identity-by-recipient";
  const [selectedIdentityId, setSelectedIdentityId] = useState(() => {
    const fallback = initial?.id ?? "";
    // Reply path uses the post-mount fetch; skip the cache lookup here so
    // the auto-detect isn't shadowed by a stale per-recipient pick.
    if (args.replyToMessageId) return fallback;
    const first = (args.toAddrs ?? [])[0]?.toLowerCase();
    if (!first) return fallback;
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(composeIdentityCacheKey);
      if (!raw) return fallback;
      const cache = JSON.parse(raw) as Record<string, string>;
      const cached = cache[first];
      if (cached && identities.some(i => i.id === cached)) return cached;
    } catch {
      // localStorage unavailable / parse error — fall through.
    }
    return fallback;
  });
  const [to, setTo] = useState((args.toAddrs ?? []).join(", "));
  const [cc, setCc] = useState((args.ccAddrs ?? []).join(", "));
  const [showCc, setShowCc] = useState((args.ccAddrs ?? []).length > 0);
  const [subject, setSubject] = useState(args.subject ?? "");
  // bodyHtml is what we send + persist; bodyText is the live plain-text
  // projection used for "is empty?" gating. Editor seeds from `seedHtml`,
  // and bumping `seedKey` resets it (used by template insertion).
  const [bodyHtml, setBodyHtml] = useState(initialBodyHtml);
  const [bodyText, setBodyText] = useState("");
  const [seedHtml, setSeedHtml] = useState(initialBodyHtml);
  const [seedKey, setSeedKey] = useState(0);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  // Split-button send menu: Send / Send and archive / Schedule. Replaces the
  // older standalone schedule popover — both options now live in this menu.
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const sendMenuRef = useRef<HTMLDivElement | null>(null);
  // "Send and archive" only makes sense for replies. We track threadId so
  // the post-send PATCH knows which thread to archive; no-op when null.
  const archiveThreadId = args.threadId ?? null;
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(args.draftId ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [isSending, startSending] = useTransition();
  const [isSavingDraft, startSavingDraft] = useTransition();

  const fromIdentity = useMemo(
    () => identities.find(i => i.id === selectedIdentityId),
    [identities, selectedIdentityId],
  );
  // Derived send-target. mailbox_id is what the API requires; alias_id is
  // the optional send-as override. Both come from the chosen identity row.
  const fromMailboxId = fromIdentity?.mailbox_id ?? "";
  const sendAsAliasId = fromIdentity?.kind === "alias" ? fromIdentity.alias_id : null;

  // Auto-default identity on reply: if the original was addressed To: or
  // Cc: one of the user's identities (mailbox OR promoted alias), pick that
  // one so the user replies *as* the address the sender wrote to. Falls
  // back to the previously-picked identity if no match is found.
  //
  // The data isn't on ComposeOpenArgs (ThreadView/ReplyButton are off-limits
  // in this issue), so we fetch the parent's recipients via /api/messages/<id>/recipients.
  // We also remember the last-used identity per outgoing-recipient in
  // localStorage so subsequent compose-to-the-same-address picks the same
  // From by default — useful when one human owns multiple aliases.
  useEffect(() => {
    let cancelled = false;
    async function pickFromReply() {
      if (!args.replyToMessageId) return;
      try {
        const res = await fetch(
          `/api/messages/${args.replyToMessageId}/recipients`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const j = (await res.json()) as { to?: string[]; cc?: string[] };
        if (cancelled) return;
        const candidates = [...(j.to ?? []), ...(j.cc ?? [])].map(a =>
          a.toLowerCase(),
        );
        const match = identities.find(i =>
          candidates.includes(`${i.local_part}@${i.domain_name}`.toLowerCase()),
        );
        if (match && !cancelled) setSelectedIdentityId(match.id);
      } catch {
        // Best-effort — leave the initial pick in place.
      }
    }
    void pickFromReply();
    return () => {
      cancelled = true;
    };
    // Only run once per modal instance (the modal remounts via instanceKey
    // when a new compose opens).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Always-current handlers for the document-level keyboard shortcuts.
  // Using refs lets the listener (which captures over a single mount)
  // call into the latest `submit`/`setMinimized` without re-binding on
  // every state change.
  const submitRef = useRef<(opts?: { archiveAfterSend?: boolean }) => void>(() => {});
  const minimizeRef = useRef<() => void>(() => {});

  // ⌘/Ctrl+Enter → Send, ⌘/Ctrl+Shift+Enter → Send and archive (no-op for
  // new compose — the send goes through but the archive is a noop without
  // a threadId), Esc → minimize. Declared up here (before the
  // identities.length === 0 early return) so the hook count stays stable
  // across both render branches. Skipped when focus is inside a <select>
  // (the From picker) or while the schedule popover is open (Esc closes
  // that instead).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inSelect = target?.tagName === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !inSelect && !sendMenuOpen) {
        e.preventDefault();
        submitRef.current({ archiveAfterSend: e.shiftKey });
        return;
      }
      if (e.key === "Escape" && !inSelect && !sendMenuOpen) {
        e.preventDefault();
        minimizeRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sendMenuOpen]);

  // Keep ref targets pointing at the latest closures so the keydown
  // listener (registered once) calls into current state. No deps array →
  // runs after every render.
  useEffect(() => {
    submitRef.current = submit;
    minimizeRef.current = () => setMinimized(true);
  });

  // Close the send-menu dropdown when clicking outside.
  useEffect(() => {
    if (!sendMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!sendMenuRef.current?.contains(e.target as Node)) setSendMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [sendMenuOpen]);

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
    bodyText.trim() !== "";

  function payload() {
    return {
      mailbox_id: fromMailboxId,
      to: splitList(to),
      cc: splitList(cc),
      subject,
      body: bodyHtml,
      reply_to_message_id: args.replyToMessageId ?? null,
    };
  }

  // Best-effort: persist "this recipient → this identity" so the next
  // compose to the same first To: address defaults to the same From.
  function rememberIdentityForFirstRecipient() {
    const first = splitList(to)[0]?.toLowerCase();
    if (!first || !selectedIdentityId) return;
    try {
      const raw = window.localStorage.getItem(composeIdentityCacheKey);
      const cache = (raw ? JSON.parse(raw) : {}) as Record<string, string>;
      cache[first] = selectedIdentityId;
      window.localStorage.setItem(composeIdentityCacheKey, JSON.stringify(cache));
    } catch {
      // localStorage unavailable — non-fatal.
    }
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

  function submit(opts?: { archiveAfterSend?: boolean }) {
    setError(null);
    const toList = splitList(to);
    const ccList = splitList(cc);
    if (toList.length === 0) {
      setError("Add at least one recipient");
      return;
    }
    if (!bodyText.trim()) {
      setError("Body can't be empty");
      return;
    }
    // Archive only fires after a successful send and only when we have a
    // thread to archive. New-compose flows pass undefined → no-op.
    const shouldArchive = !!opts?.archiveAfterSend && !!archiveThreadId;

    startSending(async () => {
      // With Undo Send enabled, route through the scheduled pipeline with a
      // short hold window. The toast shown after onClose() lets the user
      // cancel within the delay; the existing cron picks the row up after.
      if (undoSendSeconds > 0) {
        const scheduledFor = Math.floor(Date.now() / 1000) + undoSendSeconds;
        const res = await fetch("/api/scheduled", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from_mailbox_id: fromMailboxId,
            send_as_alias_id: sendAsAliasId ?? undefined,
            to: toList,
            cc: ccList.length ? ccList : undefined,
            subject,
            body: bodyHtml,
            reply_to_message_id: args.replyToMessageId,
            draft_id: draftId ?? undefined,
            attachment_ids: attachments.length ? attachments.map(a => a.id) : undefined,
            scheduled_for: scheduledFor,
            kind: "undo_send",
          }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setError(b.error ?? `Send failed (${res.status})`);
          return;
        }
        const b = (await res.json()) as { id?: string };
        if (b.id) onQueuedUndoSend(b.id, undoSendSeconds);
        rememberIdentityForFirstRecipient();
        if (shouldArchive) await archiveThreadAfterSend(archiveThreadId);
        onClose();
        router.refresh();
        return;
      }

      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from_mailbox_id: fromMailboxId,
          send_as_alias_id: sendAsAliasId ?? undefined,
          to: toList,
          cc: ccList.length ? ccList : undefined,
          subject,
          body: bodyHtml,
          reply_to_message_id: args.replyToMessageId,
          draft_id: draftId ?? undefined,
          attachment_ids: attachments.length ? attachments.map(a => a.id) : undefined,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Send failed (${res.status})`);
        return;
      }
      rememberIdentityForFirstRecipient();
      if (shouldArchive) await archiveThreadAfterSend(archiveThreadId);
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
    // Drop staged uploads so we don't leave R2 + temp_uploads orphans.
    for (const a of attachments) {
      void fetch(`/api/uploads/${a.id}`, { method: "DELETE" });
    }
    onClose();
  }

  async function attachFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setIsUploading(true);
    const uploaded: UploadedFile[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setUploadError(`${file.name}: ${b.error ?? `upload failed (${res.status})`}`);
        continue;
      }
      const u = (await res.json()) as UploadedFile;
      uploaded.push(u);
    }
    if (uploaded.length > 0) {
      setAttachments(prev => [...prev, ...uploaded]);
    }
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments(prev => prev.filter(a => a.id !== id));
    void fetch(`/api/uploads/${id}`, { method: "DELETE" });
  }

  function schedule(scheduledForUnix: number) {
    setError(null);
    const toList = splitList(to);
    const ccList = splitList(cc);
    if (toList.length === 0) {
      setError("Add at least one recipient");
      return;
    }
    if (!bodyText.trim()) {
      setError("Body can't be empty");
      return;
    }
    if (scheduledForUnix <= Math.floor(Date.now() / 1000)) {
      setError("Scheduled time must be in the future");
      return;
    }
    startSending(async () => {
      const res = await fetch("/api/scheduled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from_mailbox_id: fromMailboxId,
          send_as_alias_id: sendAsAliasId ?? undefined,
          to: toList,
          cc: ccList.length ? ccList : undefined,
          subject,
          body: bodyHtml,
          reply_to_message_id: args.replyToMessageId,
          draft_id: draftId ?? undefined,
          attachment_ids: attachments.length ? attachments.map(a => a.id) : undefined,
          scheduled_for: scheduledForUnix,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Schedule failed (${res.status})`);
        return;
      }
      rememberIdentityForFirstRecipient();
      setSendMenuOpen(false);
      onClose();
      router.refresh();
      router.push("/scheduled");
    });
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
    const filledHtml = toHtml(fillTemplate(t.body_template, ctx));
    const next = bodyHtml.trim() ? `${bodyHtml}<p><br></p>${filledHtml}` : filledHtml;
    setSeedHtml(next);
    setBodyHtml(next);
    setSeedKey(k => k + 1);
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
            value={selectedIdentityId}
            onChange={e => setSelectedIdentityId(e.target.value)}
            className="w-full bg-transparent border-none focus:outline-none"
          >
            {identities.map(i => (
              <option key={i.id} value={i.id}>
                {i.display_name
                  ? `${i.display_name} <${i.local_part}@${i.domain_name}>`
                  : `${i.local_part}@${i.domain_name}`}
                {i.kind === "alias" ? " (alias)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <RecipientInput
            value={to}
            onChange={setTo}
            mailboxId={fromMailboxId}
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
            <RecipientInput value={cc} onChange={setCc} mailboxId={fromMailboxId} />
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

      <div className="border-t border-neutral-200 dark:border-neutral-800">
        <RichTextEditor
          initialHtml={seedHtml}
          resetKey={seedKey}
          minHeight={220}
          placeholder="Write your message…"
          onChange={(html, text) => {
            setBodyHtml(html);
            setBodyText(text);
          }}
        />
      </div>

      {(attachments.length > 0 || uploadError) && (
        <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-800 space-y-2">
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {attachments.map(a => (
                <li
                  key={a.id}
                  className="inline-flex items-center gap-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1 text-xs"
                >
                  <span className="font-medium truncate max-w-[16rem]">
                    {a.filename || "attachment"}
                  </span>
                  <span className="text-neutral-500">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename ?? "attachment"}`}
                    className="text-neutral-500 hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {uploadError && <div className="text-xs text-red-600">{uploadError}</div>}
        </div>
      )}

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
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={e => attachFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            title="Attach files"
            aria-label="Attach files"
            className="rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900 disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M9.93 2.04a3.5 3.5 0 0 1 4.95 4.95l-7.07 7.07a2.5 2.5 0 0 1-3.54-3.54l6.36-6.36a1.5 1.5 0 0 1 2.12 2.12L6.4 12.63a.5.5 0 1 1-.71-.71l5.66-5.66a.5.5 0 0 0-.71-.71L4.27 11.94a1.5 1.5 0 0 0 2.12 2.12l7.07-7.07a2.5 2.5 0 0 0-3.53-3.54L9.93 2.04Z" />
            </svg>
          </button>
          <span className="text-xs text-neutral-500">
            {isUploading
              ? "Uploading…"
              : isSavingDraft
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
          <div ref={sendMenuRef} className="relative inline-flex">
            <button
              type="button"
              onClick={() => submit()}
              disabled={isSending}
              className="rounded-l-md bg-[var(--color-brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {isSending ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              onClick={() => setSendMenuOpen(o => !o)}
              disabled={isSending}
              title="More send options"
              aria-label="More send options"
              aria-haspopup="menu"
              aria-expanded={sendMenuOpen}
              className="rounded-r-md bg-[var(--color-brand)] px-2 py-1.5 text-sm font-medium text-white border-l border-white/30 hover:brightness-95 disabled:opacity-50"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.22 5.22a.75.75 0 0 1 1.06 0L8 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
            {sendMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 bottom-full mb-1 z-30 w-72 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg overflow-hidden"
              >
                <button
                  type="button"
                  role="menuitem"
                  onMouseDown={e => {
                    e.preventDefault();
                    setSendMenuOpen(false);
                    submit({ archiveAfterSend: true });
                  }}
                  disabled={isSending || !archiveThreadId}
                  title={
                    archiveThreadId
                      ? "Send and archive this thread (⌘⇧⏎)"
                      : "Only available on replies"
                  }
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span>Send and archive</span>
                    <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0">
                      ⌘⇧⏎
                    </span>
                  </div>
                </button>
                <div className="border-t border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
                  <div className="text-xs uppercase tracking-wider text-neutral-500">Schedule send</div>
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={e => setScheduleAt(e.target.value)}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSendMenuOpen(false)}
                      className="rounded-md px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const ms = Date.parse(scheduleAt);
                        if (isNaN(ms)) {
                          setError("Pick a date/time");
                          return;
                        }
                        setSendMenuOpen(false);
                        schedule(Math.floor(ms / 1000));
                      }}
                      disabled={isSending || !scheduleAt}
                      className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Schedule
                    </button>
                  </div>
                  <div className="text-xs text-neutral-500">
                    Goes out at the selected time. View/cancel under Scheduled in the sidebar.
                  </div>
                </div>
              </div>
            )}
          </div>
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
              No templates yet.
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
          {templates !== null && (
            <div className="border-t border-neutral-200 dark:border-neutral-800">
              <a
                href="/inbox/templates"
                onMouseDown={() => setOpen(false)}
                className="block px-3 py-2 text-xs text-[var(--color-brand)] hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Manage templates →
              </a>
            </div>
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
  // Mobile-only drag-to-minimize. Touch on the drag handle, pull down past
  // the threshold, and the modal minimizes (same effect as backdrop tap)
  // so the user can see the thread underneath. We track touches on the
  // handle only — attaching to the whole modal would break body scrolling.
  const [dragY, setDragY] = useState(0);
  const startYRef = useRef<number | null>(null);
  const dismissThreshold = 90;

  function onTouchStart(e: React.TouchEvent) {
    startYRef.current = e.touches[0].clientY;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (startYRef.current == null) return;
    const dy = e.touches[0].clientY - startYRef.current;
    setDragY(Math.max(0, dy));
  }
  function onTouchEnd() {
    if (dragY > dismissThreshold) {
      onBackdrop();
    }
    setDragY(0);
    startYRef.current = null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end bg-black/30 sm:p-6"
      onClick={onBackdrop}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragY > 0 ? "none" : "transform 0.2s ease-out",
        }}
        className="w-full h-full sm:h-auto sm:w-[560px] sm:max-h-[85vh] flex flex-col bg-white dark:bg-neutral-950 shadow-xl overflow-hidden sm:rounded-lg sm:border sm:border-neutral-200 sm:dark:border-neutral-800"
      >
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onClick={onBackdrop}
          role="button"
          aria-label="Minimize compose — also drag down"
          className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none"
        >
          <div className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
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
    <div
      className="fixed inset-x-4 sm:inset-x-auto sm:right-4 sm:w-72 z-50 rounded-lg bg-white dark:bg-neutral-950 shadow-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
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

// Best-effort PATCH to archive the thread after a successful send. We
// deliberately swallow errors — the send already landed, and the user can
// still archive manually if this PATCH fails.
async function archiveThreadAfterSend(threadId: string): Promise<void> {
  try {
    await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
  } catch {
    // Silent — see comment above.
  }
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

// Reply: pick the mailbox that received the original. Compose with a single
// mailbox selected: pick that mailbox. Compose from a domain scope: that
// domain's catch-all (or first mailbox). Otherwise: first identity.
//
// Aliases are skipped at this step — the per-recipient localStorage cache
// and the reply-time auto-detect (in ComposeModal's useEffect) override
// this initial pick when there's a better match. Falling through to the
// mailbox identity here keeps single-mailbox-no-aliases setups behaving
// exactly as before.
function pickInitialIdentity(identities: Identity[], args: ComposeOpenArgs): Identity | undefined {
  if (args.preferredMailboxId) {
    const m = identities.find(
      i => i.kind === "mailbox" && i.mailbox_id === args.preferredMailboxId,
    );
    if (m) return m;
  }
  if (args.preferredScope && args.preferredScope !== "all") {
    // /inbox/<scope> uses the mailbox id as scope when a single mailbox is
    // selected; only special scopes like "all"/"drafts" aren't mailbox ids.
    const byMailbox = identities.find(
      i => i.kind === "mailbox" && i.mailbox_id === args.preferredScope,
    );
    if (byMailbox) return byMailbox;
    const inDomain = identities.filter(
      i => i.kind === "mailbox" && i.domain_name === args.preferredScope,
    );
    if (inDomain.length > 0) {
      return inDomain.find(i => i.is_catch_all === 1) ?? inDomain[0];
    }
  }
  return identities.find(i => i.kind === "mailbox") ?? identities[0];
}
