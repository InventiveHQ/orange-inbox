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
