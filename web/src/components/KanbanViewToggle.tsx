"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// List / Board segmented control for a mailbox inbox. Switching writes (or
// strips) `?view=board` and router.refresh()es so the layout's data fetch
// picks up the new param via the next-url header workaround — same pattern as
// AssignmentStatusTabs / CategoryTabs.
//
// Rendered both in the list-view header (layout.tsx) and the board header
// (KanbanBoard.tsx), so it's visible whichever mode is active.
export default function KanbanViewToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isBoard = searchParams.get("view") === "board";

  function setView(board: boolean) {
    if (board === isBoard) return;
    const params = new URLSearchParams(searchParams.toString());
    if (board) params.set("view", "board");
    else params.delete("view");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    router.refresh();
  }

  return (
    <div
      role="tablist"
      aria-label="Inbox view"
      className="inline-flex items-center rounded-md border border-neutral-300 dark:border-neutral-700 p-0.5 text-xs"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!isBoard}
        onClick={() => setView(false)}
        className={`rounded px-2 py-0.5 ${
          !isBoard
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
            : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        List
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isBoard}
        onClick={() => setView(true)}
        className={`rounded px-2 py-0.5 ${
          isBoard
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
            : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        Board
      </button>
    </div>
  );
}
