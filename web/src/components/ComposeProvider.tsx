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
import dynamic from "next/dynamic";
import type { Identity } from "@/lib/identities";
import type { ContactRow } from "@/lib/contacts";
import type { TemplateRow } from "@/lib/templates";
import { substituteVariables, type TemplateContext } from "@/lib/templates";
import { looksLikeHtml } from "@/lib/html-text";
import type { SlashCommandState, SlashNavigationHandlers } from "./RichTextEditor";
import RelativeTime from "./RelativeTime";
import UndoSendToast from "./UndoSendToast";
import { useToast } from "./ToastProvider";
import { queueSend } from "@/lib/sw-client";

// Lexical + @lexical/* is the single heaviest dependency in the client
// bundle (~200 KB+ of JS). The composer is the only thing on the inbox
// route that uses it, and the modal only mounts on a user action — so load
// the editor on demand instead of shipping Lexical to every inbox page
// load. The placeholder keeps the modal layout stable for the brief moment
// the chunk is in flight on first compose.
const RichTextEditor = dynamic(() => import("./RichTextEditor"), {
  ssr: false,
  loading: () => (
    <div
      className="px-4 py-3 text-sm text-neutral-400 dark:text-neutral-500"
      style={{ minHeight: 220 }}
    >
      Loading editor…
    </div>
  ),
});

// #66 Confidential passcode format — kept in sync with lib/send.ts. 8
// characters from a 31-symbol unambiguous alphabet (A–Z minus I/O/L, digits
// 2–9), ~40 bits of entropy. We can't import the server helper here (send.ts
// pulls in next/headers and other server-only modules), so the alphabet and
// generator are mirrored client-side. The server re-validates on send.
const CONFIDENTIAL_PASSCODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CONFIDENTIAL_PASSCODE_LENGTH = 8;
const CONFIDENTIAL_PASSCODE_RE = new RegExp(
  `^[${CONFIDENTIAL_PASSCODE_ALPHABET}]{${CONFIDENTIAL_PASSCODE_LENGTH}}$`,
);

// Mint a confidential passcode with the browser CSPRNG. Rejection-samples
// random bytes to avoid modulo bias (same approach as the server helper).
function generateConfidentialPasscode(): string {
  const alphabet = CONFIDENTIAL_PASSCODE_ALPHABET;
  const n = alphabet.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < CONFIDENTIAL_PASSCODE_LENGTH) {
    const buf = new Uint8Array(CONFIDENTIAL_PASSCODE_LENGTH);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue;
      out += alphabet[b % n];
      if (out.length === CONFIDENTIAL_PASSCODE_LENGTH) break;
    }
  }
  return out;
}

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

// Mirror the threshold in web/src/lib/send.ts (kept in sync by hand — the
// composer needs it client-side for the "✨ Will be sent as a download link"
// indicator, but the actual send-time decision is enforced server-side).
const MAIL_DROP_THRESHOLD_BYTES = 10 * 1024 * 1024;

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
  defaultTrackOpens = false,
  children,
}: {
  identities: Identity[];
  // 0 = Undo Send disabled; otherwise the configured hold window in seconds.
  undoSendSeconds: number;
  // Whether new compose modals open with "Track opens" pre-checked. Loaded
  // from the user's preferences in the server layout; defaults to off so a
  // privacy-respecting default holds when the prop is absent.
  defaultTrackOpens?: boolean;
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
          defaultTrackOpens={defaultTrackOpens}
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
  defaultTrackOpens,
  args,
  onClose,
  onQueuedUndoSend,
}: {
  identities: Identity[];
  undoSendSeconds: number;
  defaultTrackOpens: boolean;
  args: ComposeOpenArgs;
  onClose: () => void;
  onQueuedUndoSend: (scheduledId: string, delaySeconds: number) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
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

  // #66 Confidential mode state. `confidential` is the user-facing toggle
  // (off by default). `confidentialTtlDays` picks one of 1/7/30 day windows
  // for the public /p/c/<token> URL; `confidentialPasscode` is the optional
  // out-of-band code (empty = no passcode prompt) — an 8-character
  // alphanumeric code from an unambiguous alphabet, typically minted via the
  // "Generate" button. The expiry is re-computed on submit (now + ttl), so a
  // long compose session doesn't shrink the window unexpectedly.
  //
  // #69 Track-opens state. `trackOpens` defaults to the user's preference
  // (Settings → Sending → Track opens by default). The composer still lets
  // them flip it per-message either way — privacy-by-default by virtue of
  // the off-by-default preference.
  const [confidential, setConfidential] = useState(false);
  const [confidentialTtlDays, setConfidentialTtlDays] = useState<1 | 7 | 30>(7);
  const [confidentialPasscode, setConfidentialPasscode] = useState("");
  const [trackOpens, setTrackOpens] = useState(defaultTrackOpens);
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

  // ─── Slash-menu state ────────────────────────────────────────────────────
  // Surfaced from RichTextEditor when the user types "/" at the start of a
  // line / after whitespace. We filter the user's templates against the
  // live query and let the editor drive keyboard nav at HIGH priority. All
  // hooks for this feature live above the identities==0 early return so the
  // hook count stays stable across renders.
  const [slashState, setSlashState] = useState<SlashCommandState | null>(null);
  const [slashTemplates, setSlashTemplates] = useState<TemplateRow[] | null>(null);
  const [slashHighlight, setSlashHighlight] = useState(0);

  const slashFiltered = useMemo(() => {
    if (!slashState || !slashTemplates) return [];
    const q = slashState.query.toLowerCase();
    if (!q) return slashTemplates.slice(0, 8);
    return slashTemplates
      .filter(t => t.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [slashState, slashTemplates]);

  // Reset highlight whenever the filtered set changes — otherwise a stale
  // index can point past the array and Enter does nothing.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlashHighlight(0);
  }, [slashFiltered.length, slashState?.query]);

  // Lazy-load templates the first time the slash menu opens.
  useEffect(() => {
    if (!slashState || slashTemplates !== null) return;
    void (async () => {
      try {
        const res = await fetch("/api/templates");
        if (!res.ok) {
          setSlashTemplates([]);
          return;
        }
        const j = (await res.json()) as { templates?: TemplateRow[] };
        setSlashTemplates(j.templates ?? []);
      } catch {
        setSlashTemplates([]);
      }
    })();
  }, [slashState, slashTemplates]);

  // Insert a template via the slash menu — substitutes variables and
  // replaces the trigger token (`/<query>`) with the rendered HTML in one
  // editor update. Sets the subject if the template defines one and the
  // user hasn't typed a subject yet (mid-body insertion shouldn't blow away
  // an in-progress subject line).
  const insertTemplateFromSlash = useCallback(
    (t: TemplateRow) => {
      if (!slashState) return;
      const ctx: TemplateContext = {
        recipientEmail: splitList(to)[0] ?? "",
        recipientName: null,
        myName: fromIdentity?.display_name ?? null,
        myEmail: fromIdentity
          ? `${fromIdentity.local_part}@${fromIdentity.domain_name}`
          : "",
        subject,
        lastThreadSubject: args.replyToMessageId ? args.subject ?? null : null,
        threadSenderName: extractSenderFromQuoted(args.quotedHtml ?? ""),
      };
      if (t.subject_template && !subject.trim()) {
        setSubject(substituteVariables(t.subject_template, ctx));
      }
      const html = toHtml(substituteVariables(t.body_template, ctx));
      slashState.replaceWithHtml(html);
    },
    [slashState, to, fromIdentity, subject, args.replyToMessageId, args.subject, args.quotedHtml],
  );

  // Keyboard navigation handlers consulted by the editor at HIGH priority
  // while the menu is open.
  const slashNav: SlashNavigationHandlers = useMemo(
    () => ({
      onArrowDown: () => {
        if (slashFiltered.length === 0) return;
        setSlashHighlight(h => (h + 1) % slashFiltered.length);
      },
      onArrowUp: () => {
        if (slashFiltered.length === 0) return;
        setSlashHighlight(h => (h - 1 + slashFiltered.length) % slashFiltered.length);
      },
      onEnter: () => {
        const t = slashFiltered[slashHighlight];
        if (t) insertTemplateFromSlash(t);
        else slashState?.dismiss();
      },
      onTab: () => {
        const t = slashFiltered[slashHighlight];
        if (t) insertTemplateFromSlash(t);
      },
    }),
    [slashFiltered, slashHighlight, slashState, insertTemplateFromSlash],
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

  // #66 — compute the confidential payload right at send time so a long
  // compose session doesn't shrink the recipient's view window. Returns
  // undefined when the toggle is off OR when the passcode is malformed
  // (caller surfaces that as an error). Treating empty-string passcode as
  // "no passcode" matches the UX of the input — the field is optional.
  function buildConfidentialField(): { ok: true; value: { expires_at: number; passcode: string | null } | null } | { ok: false; error: string } {
    if (!confidential) return { ok: true, value: null };
    const ttlSec = confidentialTtlDays * 86400;
    const expires = Math.floor(Date.now() / 1000) + ttlSec;
    const cleaned = confidentialPasscode.trim().toUpperCase();
    if (cleaned !== "" && !CONFIDENTIAL_PASSCODE_RE.test(cleaned)) {
      return {
        ok: false,
        error: `Passcode must be ${CONFIDENTIAL_PASSCODE_LENGTH} characters (letters and digits) or blank.`,
      };
    }
    return {
      ok: true,
      value: { expires_at: expires, passcode: cleaned === "" ? null : cleaned },
    };
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
    const confidentialPayload = buildConfidentialField();
    if (!confidentialPayload.ok) {
      setError(confidentialPayload.error);
      return;
    }
    // Confidential + track-opens are mutually exclusive: the recipient
    // never receives the real body, so there's nothing for the tracker to
    // attach to. Silently strip rather than reject — the UI already greys
    // out the tracking toggle when confidential is on.
    const effectiveTrackOpens = trackOpens && !confidential;
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
            confidential: confidentialPayload.value ?? undefined,
            track_opens: effectiveTrackOpens ? true : undefined,
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

      const sendPayload = {
        from_mailbox_id: fromMailboxId,
        send_as_alias_id: sendAsAliasId ?? undefined,
        to: toList,
        cc: ccList.length ? ccList : undefined,
        subject,
        body: bodyHtml,
        reply_to_message_id: args.replyToMessageId,
        draft_id: draftId ?? undefined,
        attachment_ids: attachments.length ? attachments.map(a => a.id) : undefined,
        confidential: confidentialPayload.value ?? undefined,
        track_opens: effectiveTrackOpens ? true : undefined,
      };
      let res: Response;
      try {
        res = await fetch("/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sendPayload),
        });
      } catch {
        // Network failure (offline, DNS, etc). Hand the payload to the
        // service worker so it can replay once we're back online. Falls
        // back to surfacing the error if the SW isn't around (e.g. plain
        // HTTP dev) so the user isn't left thinking it queued silently.
        const queuedId = await queueSend(sendPayload);
        if (queuedId === null) {
          setError("You're offline. Try again when you have a connection.");
          return;
        }
        toast({ message: "Queued — will send when online." });
        rememberIdentityForFirstRecipient();
        // Best-effort registration of a Background Sync tag so Chromium can
        // replay even if the app is closed by the time we reconnect.
        try {
          const reg = await navigator.serviceWorker?.ready;
          // SyncManager isn't in the standard lib.dom types yet.
          const sync = (reg as unknown as { sync?: { register: (tag: string) => Promise<void> } })
            ?.sync;
          await sync?.register("orange-outbox-flush");
        } catch {}
        onClose();
        return;
      }
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
    const confidentialPayload = buildConfidentialField();
    if (!confidentialPayload.ok) {
      setError(confidentialPayload.error);
      return;
    }
    const effectiveTrackOpens = trackOpens && !confidential;
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
          confidential: confidentialPayload.value ?? undefined,
          track_opens: effectiveTrackOpens ? true : undefined,
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
      router.push("/inbox/scheduled");
    });
  }

  // Build the substitution context from current compose state. Derives
  // last_thread_subject from `args.subject` (strips Re:/Fwd: prefixes when
  // we're replying), and thread_sender_name from the quoted-original block
  // when one's available (best-effort regex match against the
  // "On <date>, <name> <email> wrote:" intro that ReplyButton synthesises).
  function buildTemplateCtx(): TemplateContext {
    const recipientEmail = splitList(to)[0] ?? "";
    return {
      recipientEmail,
      recipientName: null,
      myName: fromIdentity?.display_name ?? null,
      myEmail: fromIdentity
        ? `${fromIdentity.local_part}@${fromIdentity.domain_name}`
        : "",
      subject,
      lastThreadSubject: args.replyToMessageId ? args.subject ?? null : null,
      threadSenderName: extractSenderFromQuoted(args.quotedHtml ?? ""),
    };
  }

  function applyTemplate(t: TemplateRow) {
    const ctx = buildTemplateCtx();
    if (t.subject_template) setSubject(substituteVariables(t.subject_template, ctx));
    const filledHtml = toHtml(substituteVariables(t.body_template, ctx));
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
        <RecipientTzPills value={to} mailboxId={fromMailboxId} />
        {showCc && (
          <Field label="Cc">
            <RecipientInput value={cc} onChange={setCc} mailboxId={fromMailboxId} />
          </Field>
        )}
        {showCc && <RecipientTzPills value={cc} mailboxId={fromMailboxId} />}
        <Field label="Subject">
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            className="w-full bg-transparent border-none focus:outline-none"
          />
        </Field>
      </div>

      <div className="border-t border-neutral-200 dark:border-neutral-800 relative">
        <RichTextEditor
          initialHtml={seedHtml}
          resetKey={seedKey}
          minHeight={220}
          placeholder="Write your message… (type / to insert a template)"
          onChange={(html, text) => {
            setBodyHtml(html);
            setBodyText(text);
          }}
          onSlashStateChange={setSlashState}
          slashNavigationHandlers={slashNav}
        />
        {slashState && (
          <SlashMenu
            anchorRect={slashState.anchorRect}
            templates={slashFiltered}
            highlight={slashHighlight}
            onPick={insertTemplateFromSlash}
            onHover={setSlashHighlight}
            loading={slashTemplates === null}
          />
        )}
      </div>

      {(attachments.length > 0 || uploadError) && (
        <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-800 space-y-2">
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {attachments.map(a => {
                const willMailDrop = a.size > MAIL_DROP_THRESHOLD_BYTES;
                return (
                  <li
                    key={a.id}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1 text-xs"
                  >
                    <span className="font-medium truncate max-w-[16rem]">
                      {a.filename || "attachment"}
                    </span>
                    <span className="text-neutral-500">{formatBytes(a.size)}</span>
                    {willMailDrop && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 text-[10px] font-medium"
                        title="Files larger than 10 MB are sent as a secure download link instead of being inlined into the message — keeps you under common mailbox size limits."
                      >
                        ✨ Sent as download link
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.filename ?? "attachment"}`}
                      className="text-neutral-500 hover:text-red-600"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
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
                  <div className="text-xs uppercase tracking-wider text-neutral-500">Privacy</div>
                  <PrivacyToggles
                    confidential={confidential}
                    onConfidentialChange={setConfidential}
                    confidentialTtlDays={confidentialTtlDays}
                    onConfidentialTtlChange={setConfidentialTtlDays}
                    confidentialPasscode={confidentialPasscode}
                    onConfidentialPasscodeChange={setConfidentialPasscode}
                    trackOpens={trackOpens}
                    onTrackOpensChange={setTrackOpens}
                  />
                </div>
                <div className="border-t border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
                  <div className="text-xs uppercase tracking-wider text-neutral-500">Schedule send</div>
                  <SchedulePresets
                    recipientEmail={splitList(to)[0] ?? ""}
                    onPick={unix => {
                      setSendMenuOpen(false);
                      schedule(unix);
                    }}
                    disabled={isSending}
                  />
                  <div className="text-xs uppercase tracking-wider text-neutral-500 pt-2">Or pick a time</div>
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

// ─── Privacy toggles (issue #66 + #69) ─────────────────────────────────────
//
// Two related but independent controls in the send-menu dropdown:
//   - Confidential mode: recipient gets a placeholder body + link; the real
//     content lives at /p/c/<token> until expiry. Optional 8-character
//     alphanumeric passcode is shared out-of-band by the sender.
//   - Track opens: outbound HTML carries a 1×1 PNG that pings the server.
//     Mutually exclusive with confidential (no real body to attach to).
//
// Both default off. Track-opens default can be flipped per-user under
// Settings → Sending; confidential is always opt-in per-message.
function PrivacyToggles({
  confidential,
  onConfidentialChange,
  confidentialTtlDays,
  onConfidentialTtlChange,
  confidentialPasscode,
  onConfidentialPasscodeChange,
  trackOpens,
  onTrackOpensChange,
}: {
  confidential: boolean;
  onConfidentialChange: (next: boolean) => void;
  confidentialTtlDays: 1 | 7 | 30;
  onConfidentialTtlChange: (next: 1 | 7 | 30) => void;
  confidentialPasscode: string;
  onConfidentialPasscodeChange: (next: string) => void;
  trackOpens: boolean;
  onTrackOpensChange: (next: boolean) => void;
}) {
  const tracksDisabled = confidential;
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confidential}
          onChange={e => onConfidentialChange(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="font-medium">Confidential</span>
          <span className="block text-xs text-neutral-500">
            Recipient sees a placeholder + link; the message body never leaves our server.
          </span>
        </span>
      </label>
      {confidential && (
        <div className="ml-6 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-neutral-500">Expires</span>
            <div className="inline-flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden text-xs">
              {[1, 7, 30].map(d => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={confidentialTtlDays === d}
                  onClick={() => onConfidentialTtlChange(d as 1 | 7 | 30)}
                  className={`px-2 py-1 ${
                    confidentialTtlDays === d
                      ? "bg-[var(--color-brand)] text-white"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <label className="block text-xs">
            <span className="uppercase tracking-wider text-neutral-500">Passcode (optional)</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={CONFIDENTIAL_PASSCODE_LENGTH}
                placeholder={`${CONFIDENTIAL_PASSCODE_LENGTH} characters`}
                value={confidentialPasscode}
                onChange={e =>
                  onConfidentialPasscodeChange(
                    e.target.value
                      .toUpperCase()
                      .split("")
                      .filter(ch => CONFIDENTIAL_PASSCODE_ALPHABET.includes(ch))
                      .join("")
                      .slice(0, CONFIDENTIAL_PASSCODE_LENGTH),
                  )
                }
                className="w-40 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 font-mono tracking-[0.2em] uppercase focus:outline-none focus:border-[var(--color-brand)]"
              />
              <button
                type="button"
                onClick={() => onConfidentialPasscodeChange(generateConfidentialPasscode())}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-[11px] hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Generate
              </button>
            </div>
            <span className="block mt-1 text-[11px] text-neutral-500">
              Share it with the recipient yourself (text/voice). They&apos;ll be prompted on the view page.
            </span>
          </label>
        </div>
      )}
      <label
        className={`flex items-start gap-2 text-sm ${tracksDisabled ? "opacity-50" : ""}`}
        title={tracksDisabled ? "Not available in Confidential mode" : undefined}
      >
        <input
          type="checkbox"
          checked={!tracksDisabled && trackOpens}
          onChange={e => onTrackOpensChange(e.target.checked)}
          disabled={tracksDisabled}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="font-medium">Track opens</span>
          <span className="block text-xs text-neutral-500">
            Notify you when the recipient&apos;s mail client loads the message. Image-stripping clients won&apos;t register.
          </span>
        </span>
      </label>
    </div>
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
                  <div className="flex items-center gap-2 shrink-0">
                    {c.tz && <RelativeTime tz={c.tz} source={c.tz_source} />}
                    {c.scope === "personal" && (
                      <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                        personal
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Recipient tz pills (#88, batched #98) ──────────────────────────────────
//
// Resolves each finalised address in the To: / Cc: list to its address-book
// tz and renders a tiny "their local time" pill underneath the input.
// "Finalised" means terminated by a comma — we don't pill the address the
// user is currently typing.
//
// Originally this fired one /api/contacts/search per unique recipient
// (typeahead endpoint, exact-match query). For multi-attendee compose /
// large CC that's wasteful; #98 swapped it to a single POST against
// /api/contacts/batch-tz returning the tz map for every address at once.
//
// Empty / no-tz addresses are skipped silently — the row collapses to
// nothing, no layout jitter.

type TzInfo = { tz: string | null; source: ContactRow["tz_source"] };

function RecipientTzPills({
  value,
  mailboxId,
}: {
  value: string;
  mailboxId: string;
}) {
  const finalised = useMemo(() => parseFinalisedRecipients(value), [value]);
  const [tzByAddr, setTzByAddr] = useState<Map<string, TzInfo>>(new Map());

  useEffect(() => {
    if (!mailboxId || finalised.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTzByAddr(new Map());
      return;
    }
    let cancelled = false;
    // Only fetch addresses we haven't already resolved this session.
    const missing = finalised.filter(a => !tzByAddr.has(a));
    if (missing.length === 0) return;
    void (async () => {
      try {
        const res = await fetch("/api/contacts/batch-tz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Cap at 50 to match the server-side limit; in practice compose
          // recipient lists are well under that.
          body: JSON.stringify({ emails: missing.slice(0, 50) }),
        });
        if (!res.ok) return;
        const j = (await res.json()) as {
          tzByEmail?: Record<string, { tz: string | null; source: string | null }>;
        };
        if (cancelled) return;
        const next = new Map(tzByAddr);
        const map = j.tzByEmail ?? {};
        for (const addr of missing) {
          const hit = map[addr];
          if (hit) {
            // Coerce the source string back to the ContactRow tz_source
            // shape; anything unexpected becomes null so the RelativeTime
            // tooltip renders without the source-specific copy.
            const source: ContactRow["tz_source"] =
              hit.source === "manual" || hit.source === "signature" || hit.source === "domain"
                ? hit.source
                : null;
            next.set(addr, { tz: hit.tz, source });
          } else {
            next.set(addr, { tz: null, source: null });
          }
        }
        setTzByAddr(next);
      } catch {
        // Best-effort — leave addresses unresolved on network failure; the
        // pills simply won't render and the rest of compose keeps working.
      }
    })();
    return () => {
      cancelled = true;
    };
    // tzByAddr intentionally omitted — adding it would re-fire the effect
    // on every state update (the Map identity changes), which is exactly
    // the loop we want to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalised.join("|"), mailboxId]);

  // Build the visible pills. We only render addresses that resolved to a
  // contact with a known tz — otherwise the row would be a long list of
  // "no info" placeholders.
  const pills = finalised
    .map(addr => ({ addr, info: tzByAddr.get(addr) }))
    .filter((p): p is { addr: string; info: { tz: string; source: ContactRow["tz_source"] } } =>
      !!p.info && !!p.info.tz,
    );
  if (pills.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 pl-[5.5rem] -mt-1 mb-1 text-xs text-neutral-500">
      {pills.map(p => (
        <span key={p.addr} className="inline-flex items-center gap-1">
          <span className="truncate max-w-[12rem]">{p.addr}</span>
          <RelativeTime tz={p.info.tz} source={p.info.source} />
        </span>
      ))}
    </div>
  );
}

function parseFinalisedRecipients(raw: string): string[] {
  // Only addresses followed by a comma count as "finalised" — the trailing
  // partial token might still be in flight.
  const lastComma = raw.lastIndexOf(",");
  const finalisedSlice = lastComma === -1 ? "" : raw.slice(0, lastComma);
  const out: string[] = [];
  for (const part of finalisedSlice.split(",")) {
    const t = part.trim().toLowerCase();
    if (t && t.includes("@")) out.push(t);
  }
  // De-dup while preserving order.
  return Array.from(new Set(out));
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

// ─── Smart schedule-send presets ────────────────────────────────────────────
//
// Five quick options that cover the bulk of "send this later" use cases:
//   - Tomorrow morning (8am local)
//   - Tomorrow afternoon (1pm local)
//   - Monday 9am (the next Monday — "this Monday" if it's still in the future)
//   - Next week (Monday 9am — always at least 7 days out)
//   - 9am in recipient's TZ (best-effort; falls back to local 9am)
//
// All times are computed against the user's wall clock except the last,
// which calls the recipient-tz endpoint for an inferred offset.

interface PresetSpec {
  label: string;
  unix: number | null;     // null => not yet resolved (loading/inference)
  hint: string;            // displayed beneath the label, e.g. "Tomorrow, 8:00 AM"
  loading?: boolean;
}

function SchedulePresets({
  recipientEmail,
  onPick,
  disabled,
}: {
  recipientEmail: string;
  onPick: (unix: number) => void;
  disabled: boolean;
}) {
  // Inferred recipient TZ offset, in minutes east of UTC. null = loading,
  // false = inference attempted and impossible (no signal in past mail).
  // Seeded from `recipientEmail` so we don't need a synchronous setState
  // inside the effect for the empty-input case.
  const [recipientOffset, setRecipientOffset] = useState<number | null | false>(
    recipientEmail ? null : false,
  );

  useEffect(() => {
    let cancelled = false;
    if (!recipientEmail) {
      // No address to look up — render the fallback immediately. The lint
      // rule against synchronous setState-in-effect is fine to bypass here:
      // this is a one-shot transition tied to prop change, not a render
      // loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecipientOffset(false);
      return;
    }
    setRecipientOffset(null);
    void (async () => {
      try {
        const url = new URL("/api/scheduled/recipient-tz", window.location.origin);
        url.searchParams.set("email", recipientEmail);
        const res = await fetch(url.toString());
        if (!res.ok) {
          if (!cancelled) setRecipientOffset(false);
          return;
        }
        const j = (await res.json()) as { inferred: { offset_minutes: number } | null };
        if (cancelled) return;
        setRecipientOffset(j.inferred ? j.inferred.offset_minutes : false);
      } catch {
        if (!cancelled) setRecipientOffset(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipientEmail]);

  const presets = useMemo<PresetSpec[]>(() => {
    const now = new Date();
    return [
      buildLocalPreset("Tomorrow morning", addDays(atLocalHour(now, 8), 1)),
      buildLocalPreset("Tomorrow afternoon", addDays(atLocalHour(now, 13), 1)),
      buildLocalPreset("Monday 9am", nextMondayAtHour(now, 9, false)),
      buildLocalPreset("Next week", nextMondayAtHour(now, 9, true)),
      buildRecipientPreset(now, recipientOffset),
    ];
  }, [recipientOffset]);

  return (
    <ul className="space-y-0.5">
      {presets.map(p => (
        <li key={p.label}>
          <button
            type="button"
            disabled={disabled || p.unix === null || p.loading}
            onClick={() => p.unix !== null && onPick(p.unix)}
            className="w-full text-left rounded-md px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm">{p.label}</span>
              <span className="text-[10px] text-neutral-500 shrink-0">{p.hint}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Returns a Date set to the given local hour on `base`'s calendar day.
function atLocalHour(base: Date, hour: number): Date {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

// Next Monday at `hour` local time. When `forceNextWeek` is true, always
// return at least 7 days out — used by the "Next week" preset so picking
// it on a Sunday doesn't land tomorrow morning.
function nextMondayAtHour(base: Date, hour: number, forceNextWeek: boolean): Date {
  const d = atLocalHour(base, hour);
  const dow = d.getDay(); // 0=Sun, 1=Mon, …
  let delta = (1 - dow + 7) % 7;
  if (delta === 0) {
    // Today is Monday — bump to next week unless the target hour is still
    // in the future *and* we're not forcing next week.
    if (forceNextWeek || d.getTime() <= base.getTime()) delta = 7;
  } else if (forceNextWeek && delta < 7) {
    delta += 7;
  }
  return addDays(d, delta);
}

function buildLocalPreset(label: string, when: Date): PresetSpec {
  const unix = Math.floor(when.getTime() / 1000);
  // Skip the preset if it's somehow in the past (e.g. tomorrow morning when
  // it's already 11pm and the date math overshot — defensive only).
  const hint = when.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return { label, unix, hint };
}

// "9am in recipient's TZ" preset. Computes the next 9am local-to-recipient
// (next future occurrence) and translates back to UTC using the inferred
// offset. When inference is loading we render a disabled row; when it
// failed we fall back to local-time 9am with a callout in the hint.
function buildRecipientPreset(now: Date, offset: number | null | false): PresetSpec {
  if (offset === null) {
    return { label: "9am in recipient's TZ", unix: null, hint: "Inferring…", loading: true };
  }
  if (offset === false) {
    // Fall back to local 9am tomorrow — at least the user gets a working
    // option rather than a dead button.
    const fallback = addDays(atLocalHour(now, 9), now.getHours() < 9 ? 0 : 1);
    return {
      label: "9am in recipient's TZ",
      unix: Math.floor(fallback.getTime() / 1000),
      hint: "TZ unknown — using local 9am",
    };
  }
  // Compute "next 9am" in the recipient's local time. We work with the
  // current moment in UTC, shift it into recipient-local, advance to the
  // next 9am there, then shift back.
  const offsetMs = offset * 60 * 1000;
  const recipientNow = new Date(now.getTime() + offsetMs);
  // Build the recipient's local 9am of *their* current day. Because
  // `recipientNow`'s UTC fields now read as recipient-local clock,
  // setUTCHours gives us "their" 9am.
  const target = new Date(recipientNow);
  target.setUTCHours(9, 0, 0, 0);
  if (target.getTime() <= recipientNow.getTime()) {
    // Already past 9am over there — schedule for tomorrow.
    target.setUTCDate(target.getUTCDate() + 1);
  }
  // Shift back to absolute UTC.
  const unix = Math.floor((target.getTime() - offsetMs) / 1000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return {
    label: "9am in recipient's TZ",
    unix,
    hint: `UTC${sign}${oh}:${om}`,
  };
}

// ─── Slash menu (typing "/" in the editor) ─────────────────────────────────
//
// Floating popup positioned near the caret. Templates are filtered against
// the live query reported by the editor's SlashCommandPlugin. Keyboard
// navigation (Arrow/Enter/Tab/Esc) is handled by the editor at HIGH command
// priority — see SlashNavigationHandlers — so the contenteditable retains
// focus while the menu is open.
function SlashMenu({
  anchorRect,
  templates,
  highlight,
  onPick,
  onHover,
  loading,
}: {
  anchorRect: DOMRect | null;
  templates: TemplateRow[];
  highlight: number;
  onPick: (t: TemplateRow) => void;
  onHover: (idx: number) => void;
  loading: boolean;
}) {
  // Position the menu beneath the caret. We use viewport-relative coords
  // (fixed positioning) so the popup tracks the caret regardless of how
  // the modal is scrolled.
  const left = anchorRect ? Math.round(anchorRect.left) : 16;
  const top = anchorRect ? Math.round(anchorRect.bottom + 6) : 80;

  return (
    <div
      role="listbox"
      aria-label="Insert template"
      style={{ position: "fixed", left, top, maxWidth: 320 }}
      className="z-50 w-72 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg overflow-hidden"
    >
      {loading && (
        <div className="px-3 py-2 text-sm text-neutral-500">Loading…</div>
      )}
      {!loading && templates.length === 0 && (
        <div className="px-3 py-2 text-sm text-neutral-500">
          No matching templates. Manage them under Templates.
        </div>
      )}
      {!loading && templates.length > 0 && (
        <ul className="text-sm max-h-64 overflow-y-auto">
          {templates.map((t, idx) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={idx === highlight}
                onMouseEnter={() => onHover(idx)}
                onMouseDown={e => {
                  // mousedown so the editor doesn't lose its selection
                  // before we run the replace.
                  e.preventDefault();
                  onPick(t);
                }}
                className={`w-full text-left px-3 py-2 ${
                  idx === highlight
                    ? "bg-neutral-100 dark:bg-neutral-900"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                }`}
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

// Best-effort: pull the original sender's display name from the synthesised
// quoted-original HTML so {{thread_sender_name}} resolves on replies. The
// string we look for is the "On <date>, <name> <email> wrote:" intro
// emitted by ReplyButton/ReplyAllButton.
function extractSenderFromQuoted(html: string): string | null {
  if (!html) return null;
  // Strip HTML tags down to plain text for the regex.
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // "On ..., NAME <email@host> wrote:" — name is everything between the
  // last comma before " <" and " <". Fall back to null on any mismatch.
  const m = text.match(/,\s*([^,<]+?)\s*<[^>]+>\s*wrote:/i);
  if (!m) return null;
  return m[1].trim() || null;
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
