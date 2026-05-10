// Storage Explorer — read-only admin view of who/what is taking up the
// most space in the mail DBs. Three tables: top senders, top threads,
// per-domain summary. Fetches live in /lib/storage-stats.ts.
//
// TODO: future — add bulk actions ("delete all attachments from this
// sender", "delete this entire thread") gated on admin + a confirm step.
// For v1 this is purely informational so an admin can decide what to
// purge by hand via the per-message UI.

import {
  getDomainSummary,
  getTopSenders,
  getTopThreads,
} from "@/lib/storage-stats";
import { formatBytes } from "@/lib/format";

export default async function StorageManager() {
  // Run all three aggregations in parallel — each fans out across every
  // mail DB independently, so there's no shared state to serialise.
  const [senders, threads, domains] = await Promise.all([
    getTopSenders(50),
    getTopThreads(50),
    getDomainSummary(),
  ]);

  const totalBytes = domains.reduce((sum, d) => sum + d.bytes, 0);
  const totalMessages = domains.reduce((sum, d) => sum + d.msg_count, 0);
  const totalThreads = domains.reduce((sum, d) => sum + d.thread_count, 0);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Storage Explorer</h1>
        <p className="mt-1 text-xs text-neutral-500">
          {formatBytes(totalBytes)} across {totalThreads.toLocaleString()} threads /{" "}
          {totalMessages.toLocaleString()} messages
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 space-y-12">
          <Caveat />
          <Section
            title="Top senders by storage"
            empty="No messages yet."
            rows={senders.length}
          >
            <Table
              columns={["Sender", "Messages", "Storage"]}
              align={["left", "right", "right"]}
            >
              {senders.map(s => (
                <tr
                  key={s.from_addr}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2 pr-4 truncate max-w-[28rem]">
                    {s.from_addr || <span className="italic text-neutral-500">(unknown)</span>}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {s.msg_count.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(s.bytes)}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section
            title="Top threads by storage"
            empty="No threads yet."
            rows={threads.length}
          >
            <Table
              columns={["Subject", "Mailbox", "Messages", "Storage"]}
              align={["left", "left", "right", "right"]}
            >
              {threads.map(t => (
                <tr
                  key={t.thread_id}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2 pr-4 truncate max-w-[28rem]">
                    {t.subject?.trim() || (
                      <span className="italic text-neutral-500">(no subject)</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 truncate max-w-[16rem] text-neutral-600 dark:text-neutral-400">
                    {t.mailbox_label ?? (
                      <span className="italic text-neutral-500">(missing index row)</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {t.msg_count.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(t.bytes)}</td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section
            title="By sender domain"
            empty="No messages yet."
            rows={domains.length}
          >
            <Table
              columns={["Domain", "Threads", "Messages", "Storage"]}
              align={["left", "right", "right", "right"]}
            >
              {domains.map(d => (
                <tr
                  key={d.domain}
                  className="border-t border-neutral-200 dark:border-neutral-800"
                >
                  <td className="py-2 pr-4 truncate max-w-[20rem]">{d.domain}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {d.thread_count.toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {d.msg_count.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatBytes(d.bytes)}</td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Caveat() {
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-4 py-3 text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
      <p className="font-medium text-neutral-700 dark:text-neutral-300 mb-1">
        About these numbers
      </p>
      <p>
        Bytes are computed as <code>LENGTH(text_body)</code> plus the sum of
        attachment <code>size</code> values stored in the mail DB. The raw{" "}
        <code>.eml</code> source and the rendered HTML body live in R2 and have
        no <code>size</code> column, so they are <strong>excluded</strong> here.
        Treat the figures as a relative ranking, not a true on-disk total.
      </p>
      <p className="mt-1">
        This page scans every message in every mail DB on each load and may be
        slow on large mailboxes. Inactive (sealed) DBs are included.
      </p>
    </div>
  );
}

function Section({
  title,
  empty,
  rows,
  children,
}: {
  title: string;
  empty: string;
  rows: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h2>
      {rows === 0 ? (
        <p className="text-sm text-neutral-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </section>
  );
}

function Table({
  columns,
  align,
  children,
}: {
  columns: string[];
  align: ("left" | "right")[];
  children: React.ReactNode;
}) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-xs uppercase tracking-wider text-neutral-500">
          {columns.map((c, i) => (
            <th
              key={c}
              className={`py-2 pr-4 font-medium ${align[i] === "right" ? "text-right" : "text-left"}`}
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
