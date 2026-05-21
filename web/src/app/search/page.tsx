import type { ReactNode } from "react";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { listMailboxesForUser } from "@/lib/queries";
import {
  searchThreads,
  SNIPPET_MARK_START,
  SNIPPET_MARK_END,
  type SearchResult,
} from "@/lib/search";
import { formatThreadDate, senderLabel } from "@/lib/format";
import SearchBar from "@/components/SearchBar";
import SaveSearchButton from "@/components/SaveSearchButton";

// Tailwind classes for a highlighted match term. Kept as a constant so every
// <mark> renderSnippet() produces is styled identically (these used to live in
// an `[&>mark]:…` arbitrary-variant on the container back when the snippet was
// injected as HTML).
const SNIPPET_MARK_CLASS =
  "bg-yellow-200 text-neutral-900 rounded-sm px-0.5 " +
  "dark:bg-yellow-300/40 dark:text-neutral-100";

/**
 * Render an FTS5 `match_snippet` string as safe React nodes.
 *
 * `match_snippet` is RAW, attacker-controlled email text (see SearchResult in
 * web/src/lib/search.ts). FTS5 snippet() does NOT HTML-escape it — it only
 * inserts the SNIPPET_MARK_START / SNIPPET_MARK_END sentinel control
 * characters around matched terms. It therefore MUST NEVER be passed to
 * dangerouslySetInnerHTML: a subject/body like `<img src=x onerror=...>` would
 * become live HTML and execute script in our origin.
 *
 * Instead we split on the sentinels and emit JSX: plain text segments render
 * as `{seg}` (React auto-escapes them, so any attacker markup shows up as
 * inert literal text) and segments that sat between a start and end sentinel
 * render as real `<mark>` elements. The sentinels themselves never reach the
 * DOM.
 *
 * Exported so any other `match_snippet` consumer renders it the same safe way.
 */
export function renderSnippet(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = snippet;
  let key = 0;

  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_MARK_START);
    if (start === -1) {
      // No more highlights — the remainder is plain text.
      nodes.push(rest);
      break;
    }
    // Plain text before the highlight.
    if (start > 0) nodes.push(rest.slice(0, start));

    const afterStart = rest.slice(start + SNIPPET_MARK_START.length);
    const end = afterStart.indexOf(SNIPPET_MARK_END);
    if (end === -1) {
      // Unbalanced sentinel (shouldn't happen) — render the rest as plain
      // text rather than dropping it or guessing.
      nodes.push(afterStart);
      break;
    }
    const highlighted = afterStart.slice(0, end);
    nodes.push(
      <mark key={`m${key++}`} className={SNIPPET_MARK_CLASS}>
        {highlighted}
      </mark>,
    );
    rest = afterStart.slice(end + SNIPPET_MARK_END.length);
  }

  return nodes;
}

interface Props {
  searchParams: Promise<{ q?: string | string[]; scope?: string | string[] }>;
}

export default async function SearchPage(props: Props) {
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const rawScope = typeof sp.scope === "string" ? sp.scope : "";

  const user = await getCurrentUser();
  if (!user) return <SignInPrompt />;

  const mailboxes = await listMailboxesForUser(user.id);
  // Reject scope IDs the user can't read — fall back to "all".
  const scope = mailboxes.some(m => m.id === rawScope) ? rawScope : "all";
  const searchMailboxes = mailboxes.map(mb => ({
    id: mb.id,
    local_part: mb.local_part,
    domain_name: mb.domain_name,
  }));

  const results = q.trim()
    ? await searchThreads(user.id, q, scope === "all" ? {} : { mailboxId: scope })
    : [];

  return (
    <div className="flex flex-col h-screen">
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3">
        <Link
          href="/inbox/all"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 shrink-0"
        >
          ← Inbox
        </Link>
        <div className="flex-1 max-w-2xl">
          <SearchBar defaultQuery={q} defaultScope={scope} mailboxes={searchMailboxes} />
        </div>
        {q.trim() && <SaveSearchButton query={q} />}
      </header>

      {!q.trim() ? (
        <EmptyState />
      ) : results.length === 0 ? (
        <NoResults query={q} />
      ) : (
        <ResultList results={results} query={q} />
      )}
    </div>
  );
}

function ResultList({ results, query }: { results: SearchResult[]; query: string }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-2 text-xs text-neutral-500">
        {results.length} {results.length === 1 ? "result" : "results"} for{" "}
        <span className="font-medium text-neutral-700 dark:text-neutral-300">{query}</span>
      </div>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {results.map(r => {
          const sender = senderLabel(r.from_addr, r.from_name);
          const subject = r.message_subject || r.subject_normalized || "(no subject)";
          return (
            <li key={r.thread_id}>
              <Link
                href={`/inbox/all/${r.thread_id}`}
                className="block px-4 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {sender}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {formatThreadDate(r.last_message_at)}
                  </span>
                </div>
                <div className="truncate text-sm text-neutral-700 dark:text-neutral-300">
                  {subject}
                </div>
                {/*
                  match_snippet is RAW attacker-controlled email text — FTS5
                  snippet() does not HTML-escape it. renderSnippet() splits it
                  on non-HTML sentinel markers and returns auto-escaped React
                  nodes (plain text + real <mark> elements), so any markup in
                  the email body renders as inert literal text. NEVER use
                  dangerouslySetInnerHTML here. See web/src/lib/search.ts.
                */}
                <div className="mt-0.5 text-xs text-neutral-500 line-clamp-2">
                  {renderSnippet(r.match_snippet)}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-neutral-400">
                  {r.mailbox_local_part}@{r.domain_name}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-center px-6">
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-2">Search your mail</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Type a query above to search across every thread you can read. We match against
          subjects, snippets, and message bodies.
        </p>
      </div>
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-center px-6">
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-2">No results</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Nothing matched <span className="font-medium">{query}</span>. Try fewer or
          broader terms.
        </p>
      </div>
    </div>
  );
}

function SignInPrompt() {
  return (
    <div className="flex h-screen items-center justify-center text-center px-6">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold mb-2">Sign in required</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Search is gated behind Cloudflare Access.
        </p>
      </div>
    </div>
  );
}
