"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Generic toast queue. Mounted once in the inbox layout (next to
// ComposeProvider). Components fire toasts via `useToast()` instead of
// renting their own pending state.
//
// This pairs with — but doesn't replace — UndoToast. UndoToast is the
// timer+countdown affordance for serious optimistic actions (archive,
// delete, send) where the user needs an obvious "Undo" lifeline. Toast
// is for lighter feedback ("Label applied", "Marked unread") that doesn't
// need a countdown.
//
// Stacking: toasts queue vertically at the bottom-center of the viewport.
// The newest is visually on top of the stack.

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastInput {
  message: string;
  action?: ToastAction;
  // Auto-dismiss after this many ms. Defaults: 5000 without action, 12000
  // with action — actionable toasts need to stay around long enough for
  // the user to actually click.
  durationMs?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
  durationMs: number;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId++;
    const durationMs = input.durationMs ?? (input.action ? 12_000 : 5_000);
    setToasts(prev => [...prev, { ...input, id, durationMs }]);
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback no-op so a component rendered outside the provider doesn't
    // crash — surface the missed message to the console for debugging.
    return {
      toast: (t: ToastInput) => console.warn("toast() called outside ToastProvider:", t),
      dismiss: () => {},
    };
  }
  return ctx;
}

function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: ToastEntry[];
  dismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      data-no-print
      // pointer-events-none on the wrapper so toasts don't block clicks on
      // the page chrome behind them; each toast re-enables pointer events
      // for itself.
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col-reverse gap-2 pointer-events-none"
    >
      {toasts.map(t => (
        <ToastView key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastView({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    if (isActing) return;
    const handle = setTimeout(() => onDismissRef.current(), entry.durationMs);
    return () => clearTimeout(handle);
  }, [entry.durationMs, isActing]);

  async function runAction() {
    if (!entry.action || isActing) return;
    setIsActing(true);
    try {
      await entry.action.onClick();
    } finally {
      onDismissRef.current();
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto flex items-center gap-3 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 shadow-xl px-4 py-2.5 text-sm"
    >
      <span>{entry.message}</span>
      {entry.action && (
        <button
          type="button"
          onClick={runAction}
          disabled={isActing}
          className="font-medium text-[var(--color-brand)] hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {isActing ? "…" : entry.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-neutral-400 hover:text-white dark:text-neutral-500 dark:hover:text-neutral-900 leading-none px-1"
      >
        ×
      </button>
    </div>
  );
}
