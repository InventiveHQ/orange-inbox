"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// Shared optimistic-dismissal set for ThreadList. Hoisted above ThreadList
// and ThreadActions so the detail-pane Archive button can hide a row from
// the list immediately — without it, /inbox/all (which intentionally
// includes archived threads) would keep showing the just-archived row
// until the user navigates away.
//
// The set is scope-local: ThreadList clears it on scope change so a thread
// dismissed from /inbox/all still surfaces under /inbox/archived.

interface DismissedThreadsApi {
  isDismissed: (id: string) => boolean;
  hasDismissed: boolean;
  dismiss: (id: string) => void;
  dismissMany: (ids: string[]) => void;
  restore: (id: string) => void;
  clear: () => void;
}

const DismissedThreadsContext = createContext<DismissedThreadsApi | null>(null);

export function DismissedThreadsProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  const dismiss = useCallback((id: string) => {
    setIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const dismissMany = useCallback((batch: string[]) => {
    if (batch.length === 0) return;
    setIds(prev => {
      const next = new Set(prev);
      batch.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const restore = useCallback((id: string) => {
    setIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setIds(prev => (prev.size === 0 ? prev : new Set()));
  }, []);

  const api = useMemo<DismissedThreadsApi>(
    () => ({
      isDismissed: (id: string) => ids.has(id),
      hasDismissed: ids.size > 0,
      dismiss,
      dismissMany,
      restore,
      clear,
    }),
    [ids, dismiss, dismissMany, restore, clear],
  );

  return (
    <DismissedThreadsContext.Provider value={api}>
      {children}
    </DismissedThreadsContext.Provider>
  );
}

// Fallback no-op so a component rendered outside the provider doesn't
// crash. Mirrors the ToastProvider pattern — the dev sees a console hint
// instead of a runtime error.
const NOOP_API: DismissedThreadsApi = {
  isDismissed: () => false,
  hasDismissed: false,
  dismiss: () => {},
  dismissMany: () => {},
  restore: () => {},
  clear: () => {},
};

export function useDismissedThreads(): DismissedThreadsApi {
  const ctx = useContext(DismissedThreadsContext);
  if (!ctx) {
    if (typeof window !== "undefined") {
      console.warn("useDismissedThreads() called outside DismissedThreadsProvider");
    }
    return NOOP_API;
  }
  return ctx;
}
