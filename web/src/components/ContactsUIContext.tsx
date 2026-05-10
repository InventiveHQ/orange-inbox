"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ContactStage } from "@/lib/contacts";
import type { Identity } from "@/lib/identities";

// Shared state for /inbox/contacts. The drawer (ContactsSidebarBody)
// and the page body (ContactsManager) both consume this so the filter
// rows can live in the drawer while the actual list stays in the page.
//
// `mailboxFilter` is URL-driven (mirrors `?mailbox=`) because the
// server-side page.tsx loader narrows the contact query by mailbox —
// changing it has to round-trip. `stageFilter` and `tagFilter` are
// pure in-memory filters, so they stay client-side state (matching
// today's behaviour, where they were `useState` inside ContactsManager).

export type StageFilter = "all" | "none" | ContactStage;

interface ContactsUIValue {
  identities: Identity[];
  mailboxFilter: string;
  setMailboxFilter: (next: string) => void;
  stageFilter: StageFilter;
  setStageFilter: (next: StageFilter) => void;
  tagFilter: string;
  setTagFilter: (next: string) => void;
  allTags: string[];
  // ContactsManager pushes the derived tag set back up so the drawer
  // can hide the Tag filter when no contact has any tag.
  setAllTags: (tags: string[]) => void;
}

const ContactsUIContext = createContext<ContactsUIValue | null>(null);

export function ContactsUIProvider({
  identities,
  initialMailboxFilter,
  children,
}: {
  identities: Identity[];
  initialMailboxFilter: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const mailboxFilter = searchParams.get("mailbox") ?? initialMailboxFilter;
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [allTags, setAllTags] = useState<string[]>([]);

  const setMailboxFilter = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "all") params.delete("mailbox");
      else params.set("mailbox", next);
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  const value = useMemo<ContactsUIValue>(
    () => ({
      identities,
      mailboxFilter,
      setMailboxFilter,
      stageFilter,
      setStageFilter,
      tagFilter,
      setTagFilter,
      allTags,
      setAllTags,
    }),
    [identities, mailboxFilter, setMailboxFilter, stageFilter, tagFilter, allTags],
  );

  return <ContactsUIContext.Provider value={value}>{children}</ContactsUIContext.Provider>;
}

export function useContactsUI(): ContactsUIValue {
  const v = useContext(ContactsUIContext);
  if (!v) {
    throw new Error("useContactsUI must be used inside <ContactsUIProvider>");
  }
  return v;
}
