"use client";

import { useMinuteTick } from "./useMinuteTick";

// Tiny "their local time" pill (#88).
//
// Renders nothing when:
//   - tz is null/empty (we don't know the contact's zone)
//   - tz matches the viewer's own zone (both clocks read the same)
//   - tz is malformed (Intl.DateTimeFormat would throw)
//
// Otherwise renders a leading bullet + `H:MM AM their time`. The exact
// format mirrors what the inbox uses elsewhere — short numeric, no
// seconds, viewer-locale am/pm. Updates once per wall-clock minute via
// the shared tick hook (no per-component setInterval).
//
// Variant `prefix=false` drops the leading "· " for use cases where the
// caller already provides a separator (e.g. a flex row gap).
interface Props {
  tz: string | null | undefined;
  // Whether to show a leading "· " separator. Default true — most callers
  // place the pill inline after a name where the bullet provides visual
  // separation.
  prefix?: boolean;
  // Optional source annotation ('inferred from signature', etc.) shown on
  // the title attribute. Doesn't affect layout.
  source?: "manual" | "signature" | "domain" | null;
}

export default function RelativeTime({ tz, prefix = true, source = null }: Props) {
  // Tick the component once a minute. The numeric value only changes at
  // wall-clock minute boundaries, so renders that *don't* cross a boundary
  // are structurally identical (no "current time" text churn). The hook
  // returns a number we don't otherwise use — we just need React to
  // re-render us, then formatRelative pulls the current Date.now() inline.
  useMinuteTick();
  const text = formatRelative(tz);
  if (!text) return null;

  const titleParts: string[] = [`Local time in ${tz}`];
  if (source === "signature") titleParts.push("inferred from their signature");
  else if (source === "domain") titleParts.push("inferred from email domain");
  else if (source === "manual") titleParts.push("set manually");

  return (
    <span
      className="text-xs text-neutral-500 whitespace-nowrap"
      title={titleParts.join(" · ")}
    >
      {prefix ? "· " : ""}
      {text}
    </span>
  );
}

// Returns the "H:MM AM their time" string, or null when nothing should
// render. Pulled out so unit tests can hit it directly without dragging
// React into the picture.
export function formatRelative(tz: string | null | undefined): string | null {
  if (!tz) return null;
  let viewerTz: string;
  try {
    viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (viewerTz === tz) return null;
  // Cheap equality is enough — Intl normalises both, so "America/Los_Angeles"
  // matches itself but not "US/Pacific" even though they're the same zone.
  // The pill saying "5:30 PM their time" when it's actually identical to
  // the viewer's time is the strict failure mode; the cure (heavier
  // canonicalization) costs more than it saves.
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
    return `${fmt.format(new Date())} their time`;
  } catch {
    // Malformed timezone string (shouldn't happen because writes go
    // through isValidIanaTz, but renders are defensive).
    return null;
  }
}
