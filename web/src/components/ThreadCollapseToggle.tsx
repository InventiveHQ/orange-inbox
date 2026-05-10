"use client";

// Tiny presentational pair of buttons — "Expand all" / "Collapse all" — used
// by the collapsed-conversation reader. State lives in the parent
// (`ThreadMessages` keeps the per-message expanded map); this is just two
// buttons that fire the supplied callbacks.

interface Props {
  totalCount: number;
  expandedCount: number;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export default function ThreadCollapseToggle({
  totalCount,
  expandedCount,
  onExpandAll,
  onCollapseAll,
}: Props) {
  const allExpanded = expandedCount === totalCount;
  const allCollapsed = expandedCount === 0;
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 sm:px-6 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/30 text-[11px]">
      <span className="text-neutral-500">
        {expandedCount} of {totalCount} expanded
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onExpandAll}
          disabled={allExpanded}
          className="rounded-md px-2 py-1 text-[11px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/70 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={onCollapseAll}
          disabled={allCollapsed}
          className="rounded-md px-2 py-1 text-[11px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/70 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Collapse all
        </button>
      </div>
    </div>
  );
}
