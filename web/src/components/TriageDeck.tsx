"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TriageDeckCard } from "@/app/api/triage-deck/route";

// Mobile "Triage mode": a Superhuman-inspired card deck for clearing the
// post-AI human pile fast. Marketing is already filed by auto-archive, so this
// deck is small — action-needed humans first, then quiet ones.
//
// Gestures on the top card (also available as buttons for desktop / a11y):
//   →  swipe right  Archive   (done with it)
//   ←  swipe left   Keep      (leave in inbox, next card)
//   ↑  swipe up     Reply     (open the thread to reply right now)
//   ↓  swipe down   Star      (flag important, keep in inbox)
//
// Opened via the `orange:open-triage` document event (dispatched by the
// launcher button). Mounted once in the inbox layout; near-zero cost closed.

const THRESHOLD = 90; // px of travel before a release commits the action.
const FLY_MS = 180; // fly-out animation before the card unmounts.

type Action = "archive" | "keep" | "reply" | "star";

export default function TriageDeck() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<TriageDeckCard[]>([]);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [exit, setExit] = useState<Action | null>(null);
  const [undo, setUndo] = useState<TriageDeckCard | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/triage-deck");
      if (res.ok) {
        const j = (await res.json()) as { cards: TriageDeckCard[] };
        setCards(j.cards ?? []);
      } else {
        setCards([]);
      }
    } catch {
      setCards([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setUndo(null);
      void load();
    }
    document.addEventListener("orange:open-triage", onOpen);
    return () => document.removeEventListener("orange:open-triage", onOpen);
  }, [load]);

  // Lock background scroll while the deck is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const top = cards[0];

  function close() {
    setOpen(false);
    setDrag(null);
    setExit(null);
  }

  // Patch helper for the thread-state mutations (archive / star). Best-effort:
  // the optimistic deck advance already happened; a failed PATCH is logged but
  // we don't block the flow (the user can re-triage on reload).
  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await fetch(`/api/threads/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // swallow — see note above.
    }
  }

  function advance() {
    setCards(prev => prev.slice(1));
    setDrag(null);
    setExit(null);
  }

  function commit(action: Action) {
    if (!top) return;
    const card = top;

    if (action === "reply") {
      // Reply "right now": jump into the thread. Triage mode steps aside.
      router.push(`/inbox/all/${card.id}`);
      close();
      return;
    }

    // Fly the card out in the gesture's direction, then resolve.
    setExit(action);
    window.setTimeout(() => {
      if (action === "archive") {
        void patch(card.id, { archived: true });
        setUndo(card);
      } else if (action === "star") {
        void patch(card.id, { starred: !card.starred });
      }
      // "keep" just advances — the thread stays exactly as it is.
      advance();
    }, FLY_MS);
  }

  function undoArchive() {
    if (!undo) return;
    const card = undo;
    void patch(card.id, { archived: false });
    // Put it back on top so the user can re-decide.
    setCards(prev => [card, ...prev]);
    setUndo(null);
  }

  // ---- pointer drag on the top card ----
  function onPointerDown(e: React.PointerEvent) {
    if (exit) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ dx: 0, dy: 0 });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = startRef.current;
    if (!s) return;
    setDrag({ dx: e.clientX - s.x, dy: e.clientY - s.y });
  }

  function onPointerUp() {
    const d = drag;
    startRef.current = null;
    if (!d) return;
    const { dx, dy } = d;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    if (horizontal && Math.abs(dx) > THRESHOLD) {
      commit(dx > 0 ? "archive" : "keep");
    } else if (!horizontal && Math.abs(dy) > THRESHOLD) {
      commit(dy < 0 ? "reply" : "star");
    } else {
      setDrag(null); // snap back
    }
  }

  if (!open) return null;

  // Direction hint shown over the card as the user drags / on fly-out.
  const hint = exit ?? dragHint(drag);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-neutral-100 dark:bg-neutral-950">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <span className="text-sm font-semibold">Triage</span>
        {cards.length > 0 && (
          <span className="text-xs text-neutral-500">{cards.length} left</span>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Close triage"
          className="ml-auto rounded-md px-2 py-1 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
        >
          Done
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden px-4 py-6">
        {loading ? (
          <p className="mt-12 text-center text-sm text-neutral-500">Loading…</p>
        ) : !top ? (
          <div className="mt-16 text-center">
            <p className="text-2xl">🎉</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
              Deck cleared — nothing left to triage.
            </p>
          </div>
        ) : (
          <>
            {/* Next card peeking underneath for depth. */}
            {cards[1] && (
              <Card
                card={cards[1]}
                style={{
                  transform: "scale(0.95) translateY(12px)",
                  opacity: 0.6,
                }}
              />
            )}
            <Card
              card={top}
              hint={hint}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              style={topCardStyle(drag, exit)}
            />
          </>
        )}
      </div>

      {top && !loading && (
        <div className="flex items-center justify-center gap-3 px-4 py-4 border-t border-neutral-200 dark:border-neutral-800">
          <DeckButton label="Keep" sub="←" onClick={() => commit("keep")} />
          <DeckButton label="Reply" sub="↑" accent onClick={() => commit("reply")} />
          <DeckButton label="Star" sub="↓" onClick={() => commit("star")} />
          <DeckButton label="Archive" sub="→" onClick={() => commit("archive")} />
        </div>
      )}

      {undo && (
        <div className="absolute inset-x-0 bottom-24 flex justify-center">
          <button
            type="button"
            onClick={undoArchive}
            className="rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm px-4 py-2 shadow-lg"
          >
            Archived · Undo
          </button>
        </div>
      )}
    </div>
  );
}

function dragHint(drag: { dx: number; dy: number } | null): Action | null {
  if (!drag) return null;
  const { dx, dy } = drag;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return null;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  if (horizontal) return dx > 0 ? "archive" : "keep";
  return dy < 0 ? "reply" : "star";
}

function topCardStyle(
  drag: { dx: number; dy: number } | null,
  exit: Action | null,
): React.CSSProperties {
  if (exit) {
    // Fly off in the action's direction.
    const map: Record<Action, string> = {
      archive: "translateX(120%) rotate(12deg)",
      keep: "translateX(-120%) rotate(-12deg)",
      reply: "translateY(-120%)",
      star: "translateY(120%)",
    };
    return { transform: map[exit], opacity: 0, transition: `transform ${FLY_MS}ms ease, opacity ${FLY_MS}ms ease` };
  }
  if (drag) {
    const rot = drag.dx / 20;
    return { transform: `translate(${drag.dx}px, ${drag.dy}px) rotate(${rot}deg)` };
  }
  return { transition: "transform 150ms ease" };
}

const HINT_LABEL: Record<Action, string> = {
  archive: "ARCHIVE",
  keep: "KEEP",
  reply: "REPLY",
  star: "STAR",
};

function Card({
  card,
  hint,
  style,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  card: TriageDeckCard;
  hint?: Action | null;
  style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
}) {
  const sender = card.from_name || card.from_addr || "Unknown sender";
  const draggable = !!onPointerDown;
  return (
    <div
      className="absolute inset-x-4 top-6 mx-auto max-w-md select-none rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-xl"
      style={{ touchAction: "none", ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
            card.lane === "action"
              ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)]"
              : "bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
          }`}
        >
          {card.lane === "action" ? "Needs reply" : "FYI"}
        </span>
        {card.unread && (
          <span className="h-2 w-2 rounded-full bg-[var(--color-brand)]" aria-label="Unread" />
        )}
        {card.starred && <span aria-label="Starred">★</span>}
      </div>
      <p className="mt-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
        {sender}
      </p>
      <p className="mt-1 text-base font-medium text-neutral-900 dark:text-neutral-100 line-clamp-2">
        {card.subject || "(no subject)"}
      </p>
      <p className="mt-2 text-sm text-neutral-500 line-clamp-4">{card.snippet}</p>
      <p className="mt-3 text-[11px] text-neutral-400">
        {card.mailbox_local_part}@{card.domain_name}
      </p>

      {draggable && hint && (
        <span className="pointer-events-none absolute right-4 top-4 rounded-md border-2 border-[var(--color-brand)] px-2 py-0.5 text-xs font-bold text-[var(--color-brand)]">
          {HINT_LABEL[hint]}
        </span>
      )}
    </div>
  );
}

function DeckButton({
  label,
  sub,
  accent,
  onClick,
}: {
  label: string;
  sub: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center rounded-xl px-4 py-2 text-xs font-medium ${
        accent
          ? "bg-[var(--color-brand)] text-white"
          : "bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200"
      }`}
    >
      <span className="text-sm">{sub}</span>
      {label}
    </button>
  );
}
