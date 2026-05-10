"use client";

import { useCompose } from "./ComposeProvider";

export default function ComposeButton({
  scope,
  collapsed = false,
}: {
  scope: string;
  collapsed?: boolean;
}) {
  const compose = useCompose();
  if (collapsed) {
    return (
      <button
        type="button"
        data-action="compose"
        onClick={() => compose.open({ preferredScope: scope })}
        title="Compose"
        aria-label="Compose"
        className="w-full h-10 flex items-center justify-center rounded-md bg-[var(--color-brand)] text-white hover:brightness-95"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M11.06 1.94a1.5 1.5 0 0 1 2.12 0l.88.88a1.5 1.5 0 0 1 0 2.12l-7.94 7.94a2 2 0 0 1-.88.5l-2.62.7a.5.5 0 0 1-.62-.62l.7-2.62a2 2 0 0 1 .5-.88l7.86-7.94Z" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-action="compose"
      onClick={() => compose.open({ preferredScope: scope })}
      className="w-full rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white hover:brightness-95"
    >
      Compose
    </button>
  );
}
