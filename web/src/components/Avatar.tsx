// Pure-presentation avatar. Deterministic colored background from a stable
// `seed` (prefer email address over display name — same person stays the same
// color even when their display name varies across messages).

const AVATAR_PALETTE = [
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-200",
  "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200",
  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200",
];

export function colorForSeed(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function defaultLabel(seed: string): string {
  for (const ch of seed) {
    if (/[a-z0-9]/i.test(ch)) return ch.toUpperCase();
  }
  return "?";
}

// Extract up to 2 initials from a name, e.g. "Sean Conroy" -> "SC",
// "emilydavis" -> "EM", "HF" -> "HF".
function initialsFromLabel(label: string): string {
  const tokens = label.trim().split(/[\s._-]+/).filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) {
    const chars = tokens[0].match(/[a-z0-9]/gi);
    return chars ? chars.slice(0, 2).join("").toUpperCase() : "";
  }
  let out = "";
  for (const tok of tokens) {
    const m = tok.match(/[a-z0-9]/i);
    if (m) {
      out += m[0].toUpperCase();
      if (out.length >= 2) break;
    }
  }
  return out;
}

export type AvatarSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-xs",
  lg: "w-10 h-10 text-sm",
};

interface Props {
  seed: string;
  label?: string;
  size?: AvatarSize;
  ringed?: boolean;
  className?: string;
  title?: string;
}

export default function Avatar({ seed, label, size = "md", ringed = false, className = "", title }: Props) {
  const palette = colorForSeed(seed || "?");
  const text = (label && initialsFromLabel(label)) || defaultLabel(seed || "?");
  return (
    <span
      aria-hidden
      title={title}
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold ${SIZE_CLASSES[size]} ${palette} ${
        ringed ? "ring-1 ring-[var(--color-brand)]" : ""
      } ${className}`}
    >
      {text}
    </span>
  );
}
