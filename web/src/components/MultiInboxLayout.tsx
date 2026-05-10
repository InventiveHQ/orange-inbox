import { loadPaneThreads, type InboxLayoutRow } from "@/lib/inbox-layouts";
import ThreadList from "./ThreadList";

interface Props {
  layout: InboxLayoutRow;
  userId: string;
}

// Server component: takes a layout config + the current user, runs each pane's
// query through the search infrastructure in parallel, and renders the panes
// side-by-side on desktop / stacked on mobile.
//
// Each pane is its own column with a header (label + count) and a vertical
// thread list reusing <ThreadList> so the per-row rendering, swipe-archive,
// bulk actions, scroll memory, and selection UX all stay identical to the
// regular inbox view. We pass scope=`layout:<id>` so deep links into a thread
// from the pane preserve the layout context (and the [scope] route accepts
// the prefix).
export default async function MultiInboxLayout({ layout, userId }: Props) {
  // Fan-out fetch: each pane is independent (its own search query + its own
  // hydrate against threads_index), so Promise.all parallelism is the obvious
  // win — the slowest pane sets the wall-clock instead of the sum.
  const paneResults = await Promise.all(
    layout.panes.map(pane => loadPaneThreads(userId, pane)),
  );

  if (layout.panes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 px-6 text-center">
        This layout has no panes. Edit it in Settings to add some.
      </div>
    );
  }

  const scope = `layout:${layout.id}`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-2">
        <span className="text-sm font-medium">{layout.name}</span>
        {layout.is_default && (
          <span className="rounded-full bg-[var(--color-brand)]/15 text-[var(--color-brand)] text-[10px] font-medium uppercase tracking-wider px-2 py-0.5">
            default
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-500">
          {layout.panes.length} pane{layout.panes.length === 1 ? "" : "s"}
        </span>
      </header>
      {/*
        Side-by-side on >=md, stacked on smaller. Each column scrolls its own
        thread list; the outer container is the page-level scroller so the
        header stays put.
      */}
      <div className="flex-1 grid min-h-0 grid-cols-1 md:auto-cols-fr md:grid-flow-col">
        {layout.panes.map((pane, i) => {
          const result = paneResults[i];
          return (
            <PaneColumn
              key={`${i}-${pane.label}`}
              label={pane.label}
              query={result.query}
              threads={result.threads}
              scope={scope}
              showDomain={true}
              isLast={i === layout.panes.length - 1}
            />
          );
        })}
      </div>
    </div>
  );
}

interface PaneColumnProps {
  label: string;
  query: string;
  threads: Awaited<ReturnType<typeof loadPaneThreads>>["threads"];
  scope: string;
  showDomain: boolean;
  isLast: boolean;
}

function PaneColumn({ label, query, threads, scope, showDomain, isLast }: PaneColumnProps) {
  return (
    <section
      aria-label={label}
      className={`flex min-h-0 flex-col ${
        isLast ? "" : "md:border-r"
      } border-b md:border-b-0 border-neutral-200 dark:border-neutral-800`}
    >
      <header className="px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-2 bg-neutral-50/60 dark:bg-neutral-900/30">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300 truncate">
          {label}
        </span>
        <span className="text-[11px] text-neutral-500 tabular-nums">
          {threads.length}
        </span>
        {query && (
          <span
            className="ml-auto truncate text-[10px] text-neutral-400 max-w-[60%]"
            title={query}
          >
            {query}
          </span>
        )}
      </header>
      {/*
        ThreadList is a client component that already handles rendering, swipe
        archive, selection, and scroll memory keyed off pathname+search. Each
        pane gets its own scoped scroll memory because the pathname is the
        same but the rendered list differs — that's a known limitation of the
        memory keying and is acceptable for v1: jumping into a thread and back
        still drops you somewhere reasonable on the layout page.
      */}
      <ThreadList threads={threads} scope={scope} showDomain={showDomain} />
    </section>
  );
}
