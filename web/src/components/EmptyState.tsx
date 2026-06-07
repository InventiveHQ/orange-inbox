// Small inline-SVG empty-state illustration + heading/body. One component
// keeps the empty-state copy consistent across the app — each variant just
// picks a different headline, body, and (minimal) line-art glyph. Kept as a
// server component on purpose: no interactivity, and we want the SVG inlined
// in the HTML so there's no extra request.

export type EmptyStateVariant =
  | "inbox"
  | "inbox_zero"
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
  // Inbox-zero is the emotional payoff of a triage tool, so it gets a warmer,
  // brand-led treatment: a soft radial glow behind a brand-coloured glyph, a
  // larger display headline, and a gentle scale-in. Every other variant keeps
  // the quiet neutral styling — an empty mailbox or "no matches" isn't an
  // achievement to celebrate.
  const celebrate = variant === "inbox_zero";
  return (
    <div
      className="relative flex-1 flex items-center justify-center px-6 py-12 text-center"
      {...(celebrate ? { "data-inbox-zero": "" } : {})}
    >
      {celebrate && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className="h-72 w-72 rounded-full opacity-60 blur-3xl"
            style={{
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--color-brand) 45%, transparent) 0%, transparent 70%)",
            }}
          />
        </div>
      )}
      <div className="relative max-w-sm flex flex-col items-center">
        <Illustration variant={variant} />
        <h2
          className={
            celebrate
              ? "font-display mt-5 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50"
              : "font-display mt-4 text-lg font-semibold text-neutral-800 dark:text-neutral-200"
          }
        >
          {title ?? copy.title}
        </h2>
        <p
          className={`mt-1.5 text-sm ${
            celebrate
              ? "text-neutral-600 dark:text-neutral-300"
              : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
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
    title: "Nothing here",
    body: "No mail in this view yet. New messages appear here as they arrive.",
  },
  inbox_zero: {
    title: "All clear",
    body: "You've handled everything that needs you. Enjoy the quiet.",
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
    case "inbox_zero":
      // Celebratory glyph — an envelope sealed with a check, haloed by short
      // rays. Drawn in the brand colour (overriding the neutral `common`
      // stroke) so it reads as a reward, not an absence. Slightly larger than
      // the other glyphs to anchor the moment.
      return (
        <svg
          {...common}
          width={104}
          height={104}
          strokeWidth={2}
          className="text-[var(--color-brand)]"
        >
          <rect x="14" y="22" width="36" height="26" rx="3" />
          <path d="M14 25l18 13 18-13" />
          <circle cx="46" cy="20" r="9" fill="currentColor" stroke="none" />
          <path
            d="M42 20l3 3 5-6"
            stroke="#ffffff"
            strokeWidth={2.2}
          />
          {/* rays */}
          <path d="M46 4v4M58 8l-2.8 2.8M62 20h-4M58 32l-2.8-2.8" opacity={0.7} />
        </svg>
      );
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
