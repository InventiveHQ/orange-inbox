"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Active / Resolved tab strip on /inbox/assigned (#99). Mirrors CategoryTabs:
// switching writes `?status=resolved` (or strips it for the default Active
// view) and router.refresh()es so the layout's data fetch picks up the new
// param via the next-url header workaround.

const TABS = [
  { id: "active", label: "Active" },
  { id: "resolved", label: "Resolved" },
] as const;

export type AssignmentStatus = (typeof TABS)[number]["id"];

const VALID_STATUSES = new Set<string>(TABS.map(t => t.id));

export function parseAssignmentStatus(raw: string | null | undefined): AssignmentStatus {
  if (raw && VALID_STATUSES.has(raw)) return raw as AssignmentStatus;
  return "active";
}

export default function AssignmentStatusTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parseAssignmentStatus(searchParams.get("status"));

  function navigateTo(next: AssignmentStatus) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "active") {
      // Default tab — keep the URL clean (no `?status=active` carried around).
      params.delete("status");
    } else {
      params.set("status", next);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    // Same Next 16 caveat as CategoryTabs — query-only changes don't re-run
    // the layout, so force a server round-trip to refetch the list.
    router.refresh();
  }

  return (
    <div
      role="tablist"
      aria-label="Assignment status"
      className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800"
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
