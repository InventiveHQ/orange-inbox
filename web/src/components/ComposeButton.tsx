"use client";

import { useCompose } from "./ComposeProvider";

export default function ComposeButton({ scope }: { scope: string }) {
  const compose = useCompose();
  return (
    <button
      type="button"
      onClick={() => compose.open({ preferredScope: scope })}
      className="w-full rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white hover:brightness-95"
    >
      Compose
    </button>
  );
}
