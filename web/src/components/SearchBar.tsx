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

// Top-of-page search input. Submitting (Enter or click) navigates to
// /search?q=<value>[&scope=<mailbox-id>]. Scope "all" is the default and is
// omitted from the URL. The /search page is a server component that runs the
// FTS5 query and renders results.
export default function SearchBar({
  defaultQuery = "",
  defaultScope = "all",
  mailboxes = [],
  placeholder = "Search mail",
}: Props) {
  const [value, setValue] = useState(defaultQuery);
  // If the incoming scope isn't a real mailbox (e.g. "drafts", "contacts"),
  // collapse it to "all" so the dropdown shows a sensible default.
  const initialScope = mailboxes.some(m => m.id === defaultScope) ? defaultScope : "all";
  const [scope, setScope] = useState(initialScope);
  const router = useRouter();

  function submit() {
    const q = value.trim();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
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
      <label className="sr-only" htmlFor="orange-search-scope">
        Search scope
      </label>
      <select
        id="orange-search-scope"
        value={scope}
        onChange={e => setScope(e.target.value)}
        className="shrink-0 max-w-[12rem] rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
      >
        <option value="all">All inboxes</option>
        {mailboxes.map(m => (
          <option key={m.id} value={m.id}>
            {m.local_part}@{m.domain_name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="orange-search-input">
        Search mail
      </label>
      <input
        id="orange-search-input"
        type="search"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
      />
      <button
        type="submit"
        className="shrink-0 rounded-md bg-[var(--color-brand)] px-4 text-sm font-medium text-white hover:opacity-90"
      >
        Search
      </button>
    </form>
  );
}
