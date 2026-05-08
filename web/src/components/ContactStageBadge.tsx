import type { ContactStage } from "@/lib/contacts";

const STYLES: Record<ContactStage, { label: string; cls: string }> = {
  lead:      { label: "Lead",      cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
  contacted: { label: "Contacted", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" },
  qualified: { label: "Qualified", cls: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200" },
  customer:  { label: "Customer",  cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
  lost:      { label: "Lost",      cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" },
};

export default function ContactStageBadge({ stage }: { stage: ContactStage }) {
  const s = STYLES[stage];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${s.cls}`}>
      {s.label}
    </span>
  );
}
