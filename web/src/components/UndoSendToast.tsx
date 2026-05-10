"use client";

import { useState } from "react";
import UndoToast from "./UndoToast";

interface Props {
  scheduledId: string;
  delaySeconds: number;
  onUndone: (draftId: string) => void;
  onDismiss: () => void;
}

// Bottom-of-screen toast shown right after Send when Undo Send is enabled.
// The countdown is purely informational — the cancel window stays open as
// long as the row is still 'pending' on the server, which in practice
// extends past the displayed countdown (cron only ticks once a minute).
export default function UndoSendToast({ scheduledId, delaySeconds, onUndone, onDismiss }: Props) {
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    try {
      const res = await fetch(`/api/scheduled/${scheduledId}/undo`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error === "already_finalised" ? "Too late — message already sent." : (b.error ?? "Undo failed"));
        return;
      }
      const b = (await res.json()) as { draft_id?: string };
      if (b.draft_id) onUndone(b.draft_id);
      else onDismiss();
    } catch {
      setError("Undo failed");
    }
  }

  return (
    <UndoToast
      message={s => (s > 0 ? `Sending in ${s}s` : "Sending…")}
      delaySeconds={delaySeconds}
      onUndo={undo}
      onDismiss={onDismiss}
      errorMessage={error}
    />
  );
}
