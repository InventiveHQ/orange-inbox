"use client";

import { useState, useTransition } from "react";
import type { ObservedAlias, PromotedAlias } from "@/lib/aliases";

// Aliases dashboard (closes #20). Two stacked tables:
//   1. Observed addresses — distinct To: local-parts seen on inbound mail
//      hitting catch-all mailboxes, that aren't already promoted. One-click
//      "Promote" turns the row into a real alias the composer can send as.
//   2. Promoted aliases — editable display_name + signature, plus a Demote
//      button that deletes the alias (inbound routing is unaffected).
//
// Inbound mail routing isn't touched: catch-all delivery still funnels every
// localpart into the parent mailbox; the alias rows are purely a labelling
// layer used by the composer's From dropdown.
export default function AliasesManager({
  initialPromoted,
  initialObserved,
}: {
  initialPromoted: PromotedAlias[];
  initialObserved: ObservedAlias[];
}) {
  const [promoted, setPromoted] = useState(initialPromoted);
  const [observed, setObserved] = useState(initialObserved);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // After a promote/demote, refetch both lists so the observed table
  // (which depends on which addresses are already promoted) stays in sync
  // without us trying to mirror the dedup logic on the client.
  function refresh() {
    void (async () => {
      try {
        const res = await fetch("/api/aliases", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          promoted?: PromotedAlias[];
          observed?: ObservedAlias[];
        };
        setPromoted(j.promoted ?? []);
        setObserved(j.observed ?? []);
      } catch {
        // Best-effort; the local optimistic state already reflects the change.
      }
    })();
  }

  function promote(o: ObservedAlias, displayName: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/aliases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailbox_id: o.mailbox_id,
          local_part: o.local_part,
          display_name: displayName.trim() || null,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Promote failed (${res.status})`);
        return;
      }
      refresh();
    });
  }

  function demote(p: PromotedAlias) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/aliases/${p.id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Demote failed (${res.status})`);
        return;
      }
      // Optimistic — remove the row, then refresh in case demotion frees up
      // an observed-aliases slot.
      setPromoted(prev => prev.filter(x => x.id !== p.id));
      refresh();
    });
  }

  function patch(p: PromotedAlias, fields: { display_name?: string | null; signature_html?: string | null }) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/aliases/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Update failed (${res.status})`);
        return;
      }
      setPromoted(prev =>
        prev.map(x =>
          x.id === p.id
            ? {
                ...x,
                display_name:
                  fields.display_name !== undefined
                    ? fields.display_name?.trim() || null
                    : x.display_name,
                signature_html:
                  fields.signature_html !== undefined
                    ? fields.signature_html?.trim() || null
                    : x.signature_html,
              }
            : x,
        ),
      );
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Aliases</h1>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Promote any address that lands in a catch-all mailbox into a send-as
          identity. Promoted aliases appear in the composer&apos;s From menu;
          inbound mail still arrives in the parent mailbox.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 space-y-8">
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800/60 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
              Observed addresses
            </h2>
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
              {observed.length === 0 ? (
                <div className="px-4 py-6 text-sm text-neutral-500 text-center">
                  No catch-all mail observed yet. Anything you receive on a
                  catch-all (like <code>signups@</code> or <code>netflix@</code>)
                  will show up here, ready to promote.
                </div>
              ) : (
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {observed.map(o => (
                    <ObservedRow
                      key={`${o.mailbox_id}|${o.local_part}`}
                      observed={o}
                      onPromote={name => promote(o, name)}
                      disabled={isPending}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
              Promoted aliases
            </h2>
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
              {promoted.length === 0 ? (
                <div className="px-4 py-6 text-sm text-neutral-500 text-center">
                  No promoted aliases yet. Promote one above to use it as a
                  send-as identity.
                </div>
              ) : (
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {promoted.map(p => (
                    // Key includes the saved display_name + signature so a
                    // successful Save remounts the row with fresh seed
                    // state, sidestepping the "reset local form on save"
                    // useEffect pattern.
                    <PromotedRow
                      key={`${p.id}|${p.display_name ?? ""}|${(p.signature_html ?? "").length}`}
                      promoted={p}
                      onPatch={fields => patch(p, fields)}
                      onDemote={() => demote(p)}
                      disabled={isPending}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ObservedRow({
  observed,
  onPromote,
  disabled,
}: {
  observed: ObservedAlias;
  onPromote: (displayName: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-mono truncate">
            {observed.local_part}@{observed.domain_name}
          </div>
          <div className="text-xs text-neutral-500">
            via <span className="font-mono">{observed.parent_local_part}@</span>
            {" "}
            (catch-all) — {observed.hits} hit{observed.hits === 1 ? "" : "s"},
            last seen {formatRelativeSeconds(observed.last_seen_at)}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={disabled}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
        >
          {open ? "Cancel" : "Promote"}
        </button>
      </div>
      {open && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Display name (optional)"
            className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
          <button
            type="button"
            onClick={() => {
              onPromote(name);
              setOpen(false);
              setName("");
            }}
            disabled={disabled}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
    </li>
  );
}

function PromotedRow({
  promoted,
  onPatch,
  onDemote,
  disabled,
}: {
  promoted: PromotedAlias;
  onPatch: (fields: { display_name?: string | null; signature_html?: string | null }) => void;
  onDemote: () => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // Seeded from the row's saved values. Parent remounts the row when
  // those values change (key includes display_name + signature length), so
  // we never need a "reset on prop change" effect here.
  const [name, setName] = useState(promoted.display_name ?? "");
  const [sig, setSig] = useState(promoted.signature_html ?? "");
  const [confirmDemote, setConfirmDemote] = useState(false);

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm">
            <span className="font-medium">
              {promoted.display_name || promoted.local_part}
            </span>{" "}
            <span className="text-neutral-500 font-mono">
              &lt;{promoted.local_part}@{promoted.domain_name}&gt;
            </span>
          </div>
          <div className="text-xs text-neutral-500">
            on{" "}
            <span className="font-mono">
              {promoted.parent_local_part}@{promoted.domain_name}
            </span>
            {promoted.parent_is_catch_all === 1 ? " (catch-all)" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(e => !e)}
            disabled={disabled}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
          >
            {editing ? "Close" : "Edit"}
          </button>
          {confirmDemote ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmDemote(false)}
                className="rounded-md px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDemote(false);
                  onDemote();
                }}
                disabled={disabled}
                className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Confirm
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDemote(true)}
              disabled={disabled}
              className="rounded-md border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-2 py-1 text-xs hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
            >
              Demote
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
              Display name
            </span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="What recipients see in the From line"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
              Signature (HTML, optional)
            </span>
            <textarea
              value={sig}
              onChange={e => setSig(e.target.value)}
              rows={4}
              placeholder="Leave empty to use the parent mailbox's signature."
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1 text-sm font-mono focus:outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                onPatch({
                  display_name: name,
                  signature_html: sig,
                });
                setEditing(false);
              }}
              disabled={disabled}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function formatRelativeSeconds(unix: number): string {
  const secs = Math.max(1, Math.floor(Date.now() / 1000) - unix);
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
