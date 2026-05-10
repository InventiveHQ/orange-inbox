"use client";

interface Props {
  visible: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

export default function UpdateToast({ visible, onApply, onDismiss }: Props) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span className="text-neutral-700 dark:text-neutral-200">Update available</span>
      <button
        type="button"
        onClick={onApply}
        aria-label="Reload to apply update"
        className="rounded-full bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white"
      >
        Reload
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss update notification"
        className="rounded-full px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Later
      </button>
    </div>
  );
}
