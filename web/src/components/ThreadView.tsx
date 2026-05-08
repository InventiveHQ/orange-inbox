import type { ThreadDetail, ThreadMessage } from "@/lib/queries";
import { formatFullDate, senderLabel } from "@/lib/format";
import ReplyButton from "./ReplyButton";

interface Props {
  detail: ThreadDetail;
  mailboxId: string;
}

export default function ThreadView({ detail, mailboxId }: Props) {
  const { thread, messages } = detail;
  const subject = messages[0]?.subject || thread.subject_normalized;
  const lastInbound = [...messages].reverse().find(m => m.direction === "inbound");

  return (
    <article className="flex-1 overflow-y-auto">
      <header className="flex items-start justify-between gap-4 border-b border-neutral-200 dark:border-neutral-800 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{subject}</h1>
          <div className="mt-1 text-xs text-neutral-500">
            {thread.mailbox_local_part}@{thread.domain_name} · {messages.length} message
            {messages.length === 1 ? "" : "s"}
          </div>
        </div>
        {lastInbound && (
          <ReplyButton
            replyToMessageId={lastInbound.id}
            preferredMailboxId={mailboxId}
            toAddrs={[lastInbound.from_addr]}
            subject={lastInbound.subject || ""}
          />
        )}
      </header>

      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {messages.map(m => (
          <MessageBlock key={m.id} m={m} />
        ))}
      </div>
    </article>
  );
}

function MessageBlock({ m }: { m: ThreadMessage }) {
  const to = parseAddrs(m.to_json);
  return (
    <section className="px-6 py-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{senderLabel(m.from_addr, m.from_name)}</div>
          <div className="text-xs text-neutral-500">
            to {to.map(a => a.name || a.addr).join(", ")}
          </div>
        </div>
        <div className="text-xs text-neutral-500 shrink-0">{formatFullDate(m.date)}</div>
      </div>
      <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
        {m.text_body || m.snippet || "(no body)"}
      </pre>
    </section>
  );
}

function parseAddrs(json: string): Array<{ addr: string; name?: string }> {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
