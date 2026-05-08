"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type { Identity } from "@/lib/identities";

export interface ComposeOpenArgs {
  replyToMessageId?: string;
  preferredMailboxId?: string;
  preferredScope?: string;
  toAddrs?: string[];
  subject?: string;
  bodyPrefill?: string;
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
  const ctx = useMemo<ComposeCtx>(() => ({ open: a => setArgs(a ?? {}) }), []);
  return (
    <Ctx.Provider value={ctx}>
      {children}
      {args !== null && (
        <ComposeModal
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
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(args.subject ?? "");
  const [body, setBody] = useState(args.bodyPrefill ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (identities.length === 0) {
    return (
      <ModalShell onClose={onClose}>
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          You don't have access to any mailbox yet. Add a mail domain from the sidebar
          first.
        </div>
      </ModalShell>
    );
  }

  function submit() {
    setError(null);
    const toList = to.split(",").map(s => s.trim()).filter(Boolean);
    const ccList = cc.split(",").map(s => s.trim()).filter(Boolean);
    if (toList.length === 0) {
      setError("Add at least one recipient");
      return;
    }
    if (!body.trim()) {
      setError("Body can't be empty");
      return;
    }

    startTransition(async () => {
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

  return (
    <ModalShell onClose={onClose}>
      <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-sm font-medium">
          {args.replyToMessageId ? "Reply" : "New message"}
        </span>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none"
          aria-label="Close"
        >
          ×
        </button>
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
          <input
            type="text"
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="comma-separated addresses"
            className="w-full bg-transparent border-none focus:outline-none"
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
            <input
              type="text"
              value={cc}
              onChange={e => setCc(e.target.value)}
              className="w-full bg-transparent border-none focus:outline-none"
            />
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

      <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
        >
          Discard
        </button>
        <button
          onClick={submit}
          disabled={isPending}
          className="rounded-md bg-[var(--color-brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Sending…" : "Send"}
        </button>
      </footer>
    </ModalShell>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:p-6 bg-black/30"
      onClick={onClose}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-neutral-200 dark:border-neutral-800 py-1.5">
      <span className="text-xs uppercase tracking-wider text-neutral-500 w-14 shrink-0">{label}</span>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  );
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
