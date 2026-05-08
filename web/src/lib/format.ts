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
