"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CalendarSummary } from "./CalendarManager";

// Shared state for the /inbox/calendar UI. Lives at the layout level so
// the context-aware Sidebar (CalendarSidebarBody) and the page body
// (CalendarManager) can both read/write it without one having to be
// nested inside the other.
//
// State here is intentionally URL-driven where it matters: the selected
// calendar id mirrors `?calendar=…` so a copied link re-opens to the
// same view (matches the existing `?view=` / `?date=` pattern).
//
// `calendars` is fetched client-side via /api/calendar/calendars on
// mount — same approach the old CalendarManager used; we keep it here
// so a single round-trip serves both consumers and color/hidden flips
// only update one source of truth.

export const SCOPE_ALL = "all" as const;
export type ScopeSelection = typeof SCOPE_ALL | string;

interface CalendarUIValue {
  calendars: CalendarSummary[];
  scope: ScopeSelection;
  setScope: (s: ScopeSelection) => void;
  updateCalendar: (id: string, patch: { color?: string; hidden?: boolean }) => Promise<void>;
  refetch: () => Promise<void>;
  // Bumped whenever calendars or hidden flags change in a way that
  // invalidates the rendered event grid. CalendarManager watches this
  // to refetch events without re-creating its own state-management.
  changeToken: number;
}

const CalendarUIContext = createContext<CalendarUIValue | null>(null);

export function CalendarUIProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlScope: ScopeSelection = searchParams.get("calendar") ?? SCOPE_ALL;

  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [changeToken, setChangeToken] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/calendars");
      const body = (await res.json().catch(() => ({}))) as {
        calendars?: CalendarSummary[];
      };
      if (res.ok) {
        setCalendars(body.calendars ?? []);
        setChangeToken(t => t + 1);
      }
    } catch {
      // Soft-fail — the grid still renders without color prefs.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  const setScope = useCallback(
    (next: ScopeSelection) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === SCOPE_ALL) params.delete("calendar");
      else params.set("calendar", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const updateCalendar = useCallback(
    async (id: string, patch: { color?: string; hidden?: boolean }) => {
      const prev = calendars;
      setCalendars(prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
      try {
        const res = await fetch("/api/calendar/calendars", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mailbox_id: id, ...patch }),
        });
        if (!res.ok) {
          setCalendars(prev);
          refetch();
          return;
        }
        // Hidden flips affect the consolidated event window; bump the
        // token so CalendarManager's event-fetch effect re-runs.
        if (patch.hidden !== undefined) setChangeToken(t => t + 1);
      } catch {
        setCalendars(prev);
      }
    },
    [calendars, refetch],
  );

  const value = useMemo<CalendarUIValue>(
    () => ({
      calendars,
      scope: urlScope,
      setScope,
      updateCalendar,
      refetch,
      changeToken,
    }),
    [calendars, urlScope, setScope, updateCalendar, refetch, changeToken],
  );

  return <CalendarUIContext.Provider value={value}>{children}</CalendarUIContext.Provider>;
}

export function useCalendarUI(): CalendarUIValue {
  const v = useContext(CalendarUIContext);
  if (!v) {
    throw new Error("useCalendarUI must be used inside <CalendarUIProvider>");
  }
  return v;
}
