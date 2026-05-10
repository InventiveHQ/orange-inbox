"use client";

import { CONTACT_STAGES, type ContactStage } from "@/lib/contacts";
import { useContactsUI, type StageFilter } from "../ContactsUIContext";
import { stageLabel } from "../ContactsManager";

// Drawer body for /inbox/contacts. Renders the three filter rows
// (Mailbox / Stage / Tag) that used to live in ContactsManager's page
// header. Reads/writes via ContactsUIContext.

export default function ContactsSidebarBody() {
  const {
    identities,
    mailboxFilter,
    setMailboxFilter,
    stageFilter,
    setStageFilter,
    tagFilter,
    setTagFilter,
    allTags,
  } = useContactsUI();

  return (
    <div className="flex flex-col text-xs">
      <FilterGroup label="Mailbox">
        <FilterRow
          active={mailboxFilter === "all"}
          onClick={() => setMailboxFilter("all")}
        >
          All mailboxes
        </FilterRow>
        {identities.map(i => (
          <FilterRow
            key={i.mailbox_id}
            active={mailboxFilter === i.mailbox_id}
            onClick={() => setMailboxFilter(i.mailbox_id)}
          >
            {i.local_part}@{i.domain_name}
          </FilterRow>
        ))}
      </FilterGroup>

      <FilterGroup label="Stage">
        <FilterRow
          active={stageFilter === "all"}
          onClick={() => setStageFilter("all")}
        >
          All stages
        </FilterRow>
        <FilterRow
          active={stageFilter === "none"}
          onClick={() => setStageFilter("none")}
        >
          No stage
        </FilterRow>
        {CONTACT_STAGES.map(s => (
          <FilterRow
            key={s}
            active={stageFilter === s}
            onClick={() => setStageFilter(s as StageFilter)}
          >
            {stageLabel(s as ContactStage)}
          </FilterRow>
        ))}
      </FilterGroup>

      {allTags.length > 0 && (
        <FilterGroup label="Tag">
          <FilterRow
            active={tagFilter === "all"}
            onClick={() => setTagFilter("all")}
          >
            All tags
          </FilterRow>
          {allTags.map(t => (
            <FilterRow
              key={t}
              active={tagFilter === t}
              onClick={() => setTagFilter(t)}
            >
              {t}
            </FilterRow>
          ))}
        </FilterGroup>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-2">
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="px-1 space-y-0.5">{children}</div>
    </div>
  );
}

function FilterRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-md px-2 py-1 truncate ${
        active
          ? "bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-medium"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}
