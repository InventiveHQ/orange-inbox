"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface MailboxOption {
  id: string;
  local_part: string;
  domain_name: string;
}

interface Props {
  defaultQuery?: string;
  defaultScope?: string;
  mailboxes?: MailboxOption[];
  placeholder?: string;
}

// Top-of-page search input. Behaviour is context-aware: when the user has
// the Calendar or Contacts view open, the search filters that view's data
// in-place rather than jumping to the mail FTS results page.
//
// Mode → destination + placeholder:
//   mail     → /search?q=<v>[&scope=<mailbox>]
//   calendar → /inbox/calendar?q=<v>
//   contacts → /inbox/contacts?q=<v>
//
// The mailbox-scope dropdown only appears in mail mode; calendar/contacts
// don't have a sub-scope concept.
export default function SearchBar({
  defaultQuery = "",
  defaultScope = "all",
  mailboxes = [],
  placeholder,
}: Props) {
  const [value, setValue] = useState(defaultQuery);
  // Mode is fixed by the current scope at render time — the user can't
  // switch modes from the search bar, they navigate to the relevant
  // section and the placeholder/destination updates with the route.
  const mode: "mail" | "calendar" | "contacts" =
    defaultScope === "calendar"
      ? "calendar"
      : defaultScope === "contacts"
        ? "contacts"
        : "mail";

  // Mail-mode mailbox dropdown only. Non-mail modes ignore scope entirely.
  const initialScope = mailboxes.some(m => m.id === defaultScope) ? defaultScope : "all";
  const [scope, setScope] = useState(initialScope);
  const router = useRouter();

  const resolvedPlaceholder =
    placeholder ??
    (mode === "calendar"
      ? "Search calendar"
      : mode === "contacts"
        ? "Search contacts"
        : "Search mail");

  function submit() {
    const q = value.trim();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (mode === "calendar") {
      const qs = params.toString();
      router.push(qs ? `/inbox/calendar?${qs}` : "/inbox/calendar");
      return;
    }
    if (mode === "contacts") {
      const qs = params.toString();
      router.push(qs ? `/inbox/contacts?${qs}` : "/inbox/contacts");
      return;
    }
    if (scope !== "all") params.set("scope", scope);
    const qs = params.toString();
    router.push(qs ? `/search?${qs}` : "/search");
  }

  return (
    <form
      role="search"
      onSubmit={e => {
        e.preventDefault();
        submit();
      }}
      className="flex w-full items-stretch gap-2"
    >
      {mode === "mail" && (
        <>
          <label className="sr-only" htmlFor="orange-search-scope">
            Search scope
          </label>
          <select
            id="orange-search-scope"
            value={scope}
            onChange={e => setScope(e.target.value)}
            className="hidden sm:block shrink-0 max-w-[12rem] rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
          >
            <option value="all">All inboxes</option>
            {mailboxes.map(m => (
              <option key={m.id} value={m.id}>
                {m.local_part}@{m.domain_name}
              </option>
            ))}
          </select>
        </>
      )}
      <label className="sr-only" htmlFor="orange-search-input">
        {resolvedPlaceholder}
      </label>
      <div className="relative flex-1 min-w-0">
        <input
          id="orange-search-input"
          type="search"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={resolvedPlaceholder}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 pr-8 text-sm focus:border-[var(--color-brand)] focus:outline-none"
        />
        {mode === "mail" && (
          <span
            // Lightweight operator hint. Native `title` keeps this dependency-free
            // until the operator help modal in #58 lands.
            title={SEARCH_OPERATOR_HINT}
            aria-label="Search operator help"
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 cursor-help select-none items-center justify-center rounded-full border border-neutral-300 dark:border-neutral-600 text-[11px] font-semibold text-neutral-500 dark:text-neutral-400"
          >
            ?
          </span>
        )}
      </div>
      <button
        type="submit"
        className="shrink-0 rounded-md bg-[var(--color-brand)] px-4 text-sm font-medium text-white hover:opacity-90"
      >
        Search
      </button>
    </form>
  );
}

const SEARCH_OPERATOR_HINT = [
  "Search operators:",
  "  from:alice    to:bob    subject:invoice",
  "  has:attachment",
  "  is:unread     is:starred",
  "  before:2024-12-31    after:2024-01-01",
  "  mailbox:hello (or hello@example.com)",
  "",
  'Quote values with spaces: from:"Long Name"',
].join("\n");
