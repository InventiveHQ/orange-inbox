// Gmail-style "smart" date: today → time, this year → "Jan 14", older → "1/14/23".
export function formatThreadDate(unixSeconds: number, now = Date.now()): string {
  const d = new Date(unixSeconds * 1000);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString();
}

export function senderLabel(addr: string | null, name: string | null): string {
  if (name && name.trim()) return name.trim();
  if (addr) return addr;
  return "Unknown";
}

export function formatFullDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

// Coarse date bucket label for thread-list section dividers. Buckets:
// "Today" → today, "Yesterday" → exactly one calendar day prior, "This week"
// → earlier this week (Sunday-anchored, week containing today excluding the
// two named days above), "Last week" → the 7 days of the prior week,
// "This month" → earlier within the current calendar month, "{Month YYYY}"
// → anything older.
//
// We compare on calendar boundaries (not 24h windows) so a message from
// 11pm yesterday is "Yesterday" rather than "Today" merely because <24h have
// elapsed. `now` is parameterised for testability and to match the existing
// `formatThreadDate` signature.
export function dateBucket(unixSeconds: number, now = Date.now()): string {
  const d = new Date(unixSeconds * 1000);
  const today = new Date(now);

  // Midnight anchor for "today" so we can compare days as ms diffs cheaply.
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const dayDiff = Math.round((todayMidnight.getTime() - dMidnight.getTime()) / dayMs);

  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";

  // Sunday-anchored "this week" — Sunday=0…Saturday=6.
  const startOfThisWeek = new Date(todayMidnight);
  startOfThisWeek.setDate(todayMidnight.getDate() - todayMidnight.getDay());
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  if (d.getTime() >= startOfThisWeek.getTime()) return "This week";
  if (d.getTime() >= startOfLastWeek.getTime()) return "Last week";

  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) {
    return "This month";
  }

  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Coarse relative-time string for "happened N ago" annotations on resolved
// assignments and similar audit-style metadata. Buckets are intentionally
// chunky — minute / hour / day / week / month / year — because the use case
// is "give me a glance-level sense of when" rather than precision. Anything
// in the future renders as "just now" (a clock-skew or pending-resolution
// edge case rather than a real value).
//
// Lives in format.ts (not its own file) because the rest of the app's
// human-time helpers cluster here; see formatThreadDate / dateBucket.
export function formatRelativeTime(unixSeconds: number, now = Date.now()): string {
  const diffSec = Math.floor(now / 1000) - unixSeconds;
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "a minute ago";
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 45) return `${minutes} minutes ago`;
  if (minutes < 90) return "an hour ago";
  const hours = Math.floor(diffSec / 3600);
  if (hours < 24) return `${hours} hours ago`;
  if (hours < 36) return "a day ago";
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "a week ago";
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 60) return "a month ago";
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  if (days < 730) return "a year ago";
  return `${Math.floor(days / 365)} years ago`;
}

// Human-readable byte size — "1.23 MB" / "456 KB" / "12 B". Uses binary
// (1024) units, since these numbers describe SQLite storage.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // Bytes have no decimals; everything else gets two for readability.
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(2)} ${units[i]}`;
}
