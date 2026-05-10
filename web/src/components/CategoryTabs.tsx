"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Auto-categorization tab strip (#68). Renders above the thread list on the
// All-inboxes view and per-mailbox views; switching tabs re-navigates with
// `?category=<bucket>` so the layout's listThreads picks up the filter.
//
// "Primary" is the default — no `?category=` in the URL means Primary, which
// matches Gmail / Apple Mail and keeps shareable links short.

const TABS = [
  { id: "primary", label: "Primary" },
  { id: "promotions", label: "Promotions" },
  { id: "updates", label: "Updates" },
  { id: "social", label: "Social" },
  { id: "forums", label: "Forums" },
] as const;

export type CategoryTab = (typeof TABS)[number]["id"];

const VALID_TABS = new Set<string>(TABS.map(t => t.id));

export function parseCategoryParam(raw: string | null | undefined): CategoryTab {
  if (raw && VALID_TABS.has(raw)) return raw as CategoryTab;
  return "primary";
}

export default function CategoryTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parseCategoryParam(searchParams.get("category"));

  function navigateTo(next: CategoryTab) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "primary") {
      // Default tab; keep the URL clean rather than carrying a redundant
      // `?category=primary` (matches the "no view= for the default
      // quadrant" pattern used by the triage bar).
      params.delete("category");
    } else {
      params.set("category", next);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    // Layouts in Next 16 don't re-render on a query-string-only change, but
    // the inbox layout is where the SSR'd thread list lives. Force the
    // server to re-fetch so the new category filter actually applies.
    router.refresh();
  }

  return (
    <div
      role="tablist"
      aria-label="Categories"
      className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 overflow-x-auto"
    >
      {TABS.map(t => {
        const active = t.id === current;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => navigateTo(t.id)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs ${
              active
                ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
                : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
