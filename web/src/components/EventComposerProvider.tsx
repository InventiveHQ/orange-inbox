"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useToast } from "./ToastProvider";

// Lets any inbox surface (e.g. the "Add to calendar" button in a thread) open
// a prefilled calendar-event composer, mirroring ComposeProvider for mail.
// The CalendarEventForm + its rrule/recurrence machinery is heavy and only
// mounts on user action, so it's loaded on demand rather than shipped to every
// inbox page.
const CalendarEventForm = dynamic(() => import("./CalendarEventForm"), {
  ssr: false,
});

export interface EventComposerPrefill {
  summary?: string;
  startsAt?: number;
  endsAt?: number;
  allDay?: boolean;
  location?: string;
  description?: string;
}

interface EventComposerCtx {
  open: (prefill?: EventComposerPrefill) => void;
}

const Ctx = createContext<EventComposerCtx | null>(null);

export function useEventComposer(): EventComposerCtx {
  const c = useContext(Ctx);
  if (!c) {
    throw new Error("useEventComposer must be inside EventComposerProvider");
  }
  return c;
}

export default function EventComposerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [prefill, setPrefill] = useState<EventComposerPrefill | null>(null);
  // Bumped on each open so the form's internal state resets cleanly.
  const [instanceKey, setInstanceKey] = useState(0);

  const open = useCallback((p?: EventComposerPrefill) => {
    setPrefill(p ?? {});
    setInstanceKey(k => k + 1);
  }, []);

  const ctx = useMemo<EventComposerCtx>(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {prefill !== null && (
        <CalendarEventForm
          key={instanceKey}
          event={null}
          defaults={{
            startsAt: prefill.startsAt,
            endsAt: prefill.endsAt,
            allDay: prefill.allDay,
            summary: prefill.summary,
            location: prefill.location,
            description: prefill.description,
          }}
          onClose={() => setPrefill(null)}
          onSaved={() => {
            setPrefill(null);
            toast({ message: "Added to calendar" });
            router.refresh();
          }}
          onDeleted={() => setPrefill(null)}
        />
      )}
    </Ctx.Provider>
  );
}
