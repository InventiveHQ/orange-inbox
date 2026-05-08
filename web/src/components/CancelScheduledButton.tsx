"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export default function CancelScheduledButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function cancel() {
    startTransition(async () => {
      const res = await fetch(`/api/scheduled/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={cancel}
      disabled={isPending}
      className="shrink-0 text-xs text-red-600 hover:underline disabled:opacity-50"
    >
      Cancel
    </button>
  );
}
