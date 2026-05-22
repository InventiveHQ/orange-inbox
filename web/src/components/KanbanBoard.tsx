import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { loadBoard } from "@/lib/kanban";
import KanbanBoardClient from "./KanbanBoardClient";
import KanbanViewToggle from "./KanbanViewToggle";

interface Props {
  mailboxId: string;
}

// Server component for the Kanban board view of a mailbox. Fetches the board
// (columns + cards) and hands it to the interactive client. Mirrors the
// shape of MultiInboxLayout — it owns the full main column when the inbox is
// in `?view=board` mode (layout.tsx treats that as a full-page scope).
export default async function KanbanBoard({ mailboxId }: Props) {
  const user = await getCurrentUser();
  if (!user) return null;

  const board = await loadBoard(user.id, mailboxId);
  if (!board) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <div className="max-w-md">
          <h1 className="text-base font-semibold mb-2">Board unavailable</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This mailbox was deleted or you no longer have access. Try the{" "}
            <Link href="/inbox/all" className="text-[var(--color-brand)] underline">
              All inboxes view
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3">
        <span className="text-sm font-medium truncate">{board.mailbox_label}</span>
        <span className="text-xs text-neutral-500">Board</span>
        <div className="ml-auto">
          <KanbanViewToggle />
        </div>
      </header>
      <KanbanBoardClient
        mailboxId={board.mailbox_id}
        columns={board.columns}
        cards={board.cards}
        currentUserId={user.id}
      />
    </div>
  );
}
