export default function ContactTagPills({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map(t => (
        <span
          key={t}
          className="inline-flex items-center rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/40 px-1.5 py-0.5 text-[11px] text-neutral-700 dark:text-neutral-300"
        >
          #{t}
        </span>
      ))}
    </div>
  );
}
