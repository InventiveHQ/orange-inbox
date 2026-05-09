"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCompose } from "./ComposeProvider";

// Mounted inside ComposeProvider in the inbox layout. When the URL carries
// `?compose=1` (set by the server-side `/compose` route after parsing a
// `mailto:`, share-target, or shortcut intent), open the composer with the
// pre-filled fields, then strip those query params from the URL so a refresh
// or back-nav doesn't re-trigger the modal.
//
// We guard with a ref so React's StrictMode double-invoke in dev (or any
// re-render before the URL is cleaned) doesn't open the modal twice.
export default function ComposeFromUrl() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { open } = useCompose();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    if (searchParams.get("compose") !== "1") return;
    handledRef.current = true;

    const toAddrs = splitAddrs(searchParams.get("to"));
    const ccAddrs = splitAddrs(searchParams.get("cc"));
    const subject = searchParams.get("subject") ?? undefined;
    const bodyPrefill = searchParams.get("body") ?? undefined;

    open({
      toAddrs: toAddrs.length > 0 ? toAddrs : undefined,
      ccAddrs: ccAddrs.length > 0 ? ccAddrs : undefined,
      subject,
      bodyPrefill,
    });

    // Strip the compose params but preserve anything else the URL was
    // carrying — defensive in case a future query param coexists with
    // compose intent. `router.replace` keeps history clean.
    const remaining = new URLSearchParams();
    searchParams.forEach((value, key) => {
      if (key === "compose" || key === "to" || key === "cc" || key === "subject" || key === "body") {
        return;
      }
      remaining.append(key, value);
    });
    const qs = remaining.toString();
    const path = window.location.pathname;
    router.replace(qs ? `${path}?${qs}` : path);
  }, [searchParams, open, router]);

  return null;
}

function splitAddrs(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}
