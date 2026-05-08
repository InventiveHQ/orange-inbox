"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  defaultQuery?: string;
  placeholder?: string;
}

// Top-of-page search input. Submitting (Enter or click) navigates to
// /search?q=<value>. The /search page is a server component that runs the
// FTS5 query and renders results, so we don't need any client-side state
// beyond the controlled input value.
export default function SearchBar({ defaultQuery = "", placeholder = "Search mail" }: Props) {
  const [value, setValue] = useState(defaultQuery);
  const router = useRouter();

  function submit() {
    const q = value.trim();
    if (!q) {
      router.push(`/search`);
      return;
    }
    router.push(`/search?q=${encodeURIComponent(q)}`);
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
