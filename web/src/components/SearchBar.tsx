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
      className="w-full"
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
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:border-[var(--color-brand)] focus:outline-none"
      />
    </form>
  );
}
