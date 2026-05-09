"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Renders only on mobile; navigates one URL segment up.
// e.g. /inbox/all/<threadId>  ->  /inbox/all
export default function BackToListButton({ label = "Back" }: { label?: string }) {
  const pathname = usePathname();
  const parts = pathname.split("/");
  const href = parts.slice(0, -1).join("/") || "/";

  return (
    <Link
      href={href}
      aria-label={label}
      className="md:hidden inline-flex items-center justify-center w-9 h-9 -ml-1 mr-1 shrink-0 rounded-md text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
        <path d="M11.78 4.22a.75.75 0 0 1 0 1.06L8.06 9l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" />
      </svg>
    </Link>
  );
}
