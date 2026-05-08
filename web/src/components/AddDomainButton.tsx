"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function AddDomainButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    setError(null);
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter a domain");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setOpen(false);
      setName("");
      router.refresh();
      router.push(`/inbox/${encodeURIComponent(trimmed)}`);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
      >
        + Add mail domain
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <input
        autoFocus
        type="text"
        placeholder="example.com"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
      />
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setName("");
            setError(null);
          }}
          className="rounded-md px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
