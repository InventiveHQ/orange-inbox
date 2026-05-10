// Small inline-SVG empty-state illustration + heading/body. One component
// keeps the empty-state copy consistent across the app — each variant just
// picks a different headline, body, and (minimal) line-art glyph. Kept as a
// server component on purpose: no interactivity, and we want the SVG inlined
// in the HTML so there's no extra request.

export type EmptyStateVariant =
  | "inbox"
  | "drafts"
  | "contacts"
  | "search"
  | "calendar";

interface Props {
  variant: EmptyStateVariant;
  // Optional overrides — useful for context-sensitive copy (e.g. "No contacts
  // match these filters" vs "No contacts yet"). When omitted, the default
  // copy for the variant is used.
  title?: string;
  body?: string;
  // Optional CTA — rendered as a small linked button beneath the body when
  // provided. Plain anchor so it works in server components.
  action?: { label: string; href: string };
}

export default function EmptyState({ variant, title, body, action }: Props) {
  const copy = DEFAULT_COPY[variant];
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12 text-center">
      <div className="max-w-sm flex flex-col items-center">
        <Illustration variant={variant} />
        <h2 className="mt-4 text-base font-semibold text-neutral-800 dark:text-neutral-200">
          {title ?? copy.title}
        </h2>
        <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
          {body ?? copy.body}
        </p>
        {action && (
          <a
            href={action.href}
            className="mt-4 inline-flex items-center rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white"
          >
            {action.label}
          </a>
        )}
      </div>
    </div>
  );
}

const DEFAULT_COPY: Record<EmptyStateVariant, { title: string; body: string }> = {
  inbox: {
    title: "Inbox zero",
    body: "No mail in this view yet. New messages appear here as they arrive.",
  },
  drafts: {
    title: "No drafts",
    body: "Saved drafts from the compose window will appear here.",
  },
  contacts: {
    title: "No contacts yet",
    body: "Contacts are added automatically when you send mail.",
  },
  search: {
    title: "No matches",
    body: "Try different keywords or check your filters.",
  },
  calendar: {
    title: "No events",
    body: "Event invites in your mail will show up here once you accept them.",
  },
};

// Each illustration is a small line-art glyph. We intentionally keep them
// minimal — a single SVG with `currentColor` strokes so the icon picks up
// the surrounding text colour and looks coherent in both light and dark
// themes. No fills (no theme-specific colour decisions to worry about).
function Illustration({ variant }: { variant: EmptyStateVariant }) {
  const common = {
    width: 88,
    height: 88,
    viewBox: "0 0 64 64",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "text-neutral-300 dark:text-neutral-700",
  };
  switch (variant) {
    case "inbox":
    case "search":
      // Envelope outline — the universal "mail" glyph. For "search" we add a
      // magnifier on top so the same envelope reads as "no matches".
      return (
        <svg {...common}>
          <rect x="8" y="16" width="48" height="32" rx="3" />
          <path d="M8 19l24 18 24-18" />
          {variant === "search" && (
            <>
              <circle cx="46" cy="44" r="6" />
              <path d="M50.5 48.5L56 54" />
            </>
          )}
        </svg>
      );
    case "drafts":
      // Envelope with a pencil overlay.
      return (
        <svg {...common}>
          <rect x="8" y="14" width="40" height="28" rx="3" />
          <path d="M8 17l20 16 20-16" />
          <path d="M40 50l6-2 14-14-4-4-14 14-2 6z" />
        </svg>
      );
    case "contacts":
      // Person silhouette in a frame.
      return (
        <svg {...common}>
          <rect x="10" y="10" width="44" height="44" rx="6" />
          <circle cx="32" cy="26" r="6" />
          <path d="M20 46c2-6 7-9 12-9s10 3 12 9" />
        </svg>
      );
    case "calendar":
      // Wall-calendar with a small dot for "an event".
      return (
        <svg {...common}>
          <rect x="10" y="14" width="44" height="38" rx="3" />
          <path d="M10 24h44" />
          <path d="M20 10v8M44 10v8" />
          <circle cx="32" cy="38" r="2" fill="currentColor" />
        </svg>
      );
  }
}
