"use client";

import { useEffect } from "react";

/**
 * Clears the OS app badge while the user is actively viewing the inbox.
 * The service worker re-sets the badge on the next push.
 *
 * Uses the Badging API (`navigator.clearAppBadge`), which is only available
 * in some browsers (Chrome, Edge, Safari 16.4+ on installed PWAs). Calls are
 * feature-detected and wrapped in try/catch to silently no-op elsewhere.
 */
export default function AppBadgeSync() {
  useEffect(() => {
    const clear = () => {
      try {
        const nav = navigator as Navigator & {
          clearAppBadge?: () => Promise<void>;
        };
        if (typeof nav.clearAppBadge === "function") {
          // Promise rejection is intentionally ignored.
          void nav.clearAppBadge().catch(() => {});
        }
      } catch {
        // Badging API not supported or blocked — ignore.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") clear();
    };

    clear();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
