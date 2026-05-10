"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

interface Props {
  sidebar: React.ReactNode;
  topBar: React.ReactNode;
  list: React.ReactNode | null;
  main: React.ReactNode;
}

// Holds the responsive shell for the inbox layout.
// - Desktop (md+): three-pane row [sidebar][topbar+row[list][main]]
// - Mobile (<md):  sidebar is an off-canvas drawer; list and main occupy the
//   full content area, swapped by URL — the list is shown when no thread is
//   selected, the main pane is shown when /inbox/[scope]/[threadId].
export default function MobileShell({ sidebar, topBar, list, main }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();

  // /inbox/[scope]/[threadId] => 3+ segments => thread is selected.
  const segments = pathname.split("/").filter(Boolean);
  const onThread = segments[0] === "inbox" && segments.length >= 3;

  // Close the drawer on navigation so tapping a link feels like a real
  // single-pane phone app. We watch query params too — the context-aware
  // drawer body can update state via `?calendar=` / `?mailbox=` without
  // changing the pathname, and that should still dismiss the drawer
  // (otherwise picking a calendar on mobile leaves the drawer covering
  // the grid you wanted to see).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false);
  }, [pathname, searchKey]);

  return (
    <div className="flex h-screen relative">
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={`shrink-0 z-50 flex transition-transform duration-200 ease-out fixed inset-y-0 left-0 bg-white dark:bg-neutral-950 md:static md:translate-x-0 md:shadow-none ${
          drawerOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {sidebar}
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <div
          className="shrink-0 flex items-stretch border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="md:hidden flex items-center justify-center w-12 shrink-0 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800"
          >
            <HamburgerIcon />
          </button>
          <div className="flex-1 min-w-0">{topBar}</div>
        </div>

        <div className="flex flex-1 min-h-0">
          {list && (
            <section
              className={`w-full md:w-96 md:shrink-0 md:border-r md:border-neutral-200 md:dark:border-neutral-800 flex-col ${
                onThread ? "hidden md:flex" : "flex"
              }`}
            >
              {list}
            </section>
          )}
          <main
            className={`flex-1 flex-col overflow-hidden ${
              list ? (onThread ? "flex" : "hidden md:flex") : "flex"
            }`}
          >
            {main}
          </main>
        </div>
      </div>
    </div>
  );
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M3 5h14a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Zm0 4h14a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Zm0 4h14a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2Z" />
    </svg>
  );
}
