// Lightweight loading skeletons used by the route-level loading.tsx files.
// Pure CSS — no JS state, no animations beyond Tailwind's `animate-pulse`,
// so these stay cheap to render server-side and don't require hydration.
//
// Geometry mirrors the production rows roughly so the screen doesn't jump
// when real content swaps in.

interface ThreadListSkeletonProps {
  // How many placeholder rows to render. The real list typically shows ~8-12
  // before scrolling, so 8 is a reasonable default.
  rows?: number;
}

export function ThreadListSkeleton({ rows = 8 }: ThreadListSkeletonProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0" aria-busy="true" aria-live="polite">
      {/* Mirrors the section header that ThreadList eventually renders. */}
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <div className="h-4 w-24 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
      </header>
      <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="px-4 py-3">
            <div className="flex items-start gap-3">
              {/* Avatar placeholder — matches the md Avatar size used in ThreadList. */}
              <div className="h-8 w-8 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-3.5 flex-1 max-w-[8rem] rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  <div className="h-3 w-10 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                </div>
                <div className="h-3.5 w-3/4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                <div className="h-3 w-2/3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Thread reader skeleton. Header strip + a couple of "message blocks" with
// avatar, two metadata lines, and a body block. We render two message
// placeholders so the page roughly matches what users typically see (most
// threads have at least an initial inbound + one reply).
export function ThreadDetailSkeleton() {
  return (
    <article className="flex-1 overflow-y-auto" aria-busy="true" aria-live="polite">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-5 w-2/3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-3 w-1/3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-7 w-16 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-7 w-16 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
      </header>
      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {[0, 1].map(i => (
          <section key={i} className="px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-4 w-1/3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                  <div className="h-3 w-1/4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                </div>
              </div>
              <div className="h-3 w-16 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            </div>
            <div className="mt-4 space-y-2">
              <div className="h-3 w-full rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
              <div className="h-3 w-11/12 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
