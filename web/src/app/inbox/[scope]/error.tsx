"use client";

import { useEffect } from "react";

// Error boundary for a scope route (Calendar/Contacts/Settings/Help/mailbox
// views). Without this, any throw during the scope's server render — a failed
// query, a worker subrequest timeout, or a stale-bundle RSC fetch after a
// deploy — left the navigation wedged until a manual hard refresh. Now we catch
// it, auto-recover the one case we can recover (deploy version skew), and
// otherwise offer an in-place retry that re-runs the segment without losing the
// surrounding shell.

// Heuristic: a navigation that fails because the open tab is running an old
// client bundle (the build id changed under us on deploy) surfaces as a
// chunk-load / RSC-fetch failure. A hard reload pulls the new bundle and fixes
// it — but guard with sessionStorage so we never loop if the reload doesn't.
function isLikelyDeploySkew(error: Error): boolean {
  const msg = `${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return (
    msg.includes("failed to fetch rsc") ||
    msg.includes("rsc payload") ||
    msg.includes("dynamically imported module") ||
    msg.includes("loading chunk") ||
    msg.includes("loading css chunk") ||
    msg.includes("chunkloaderror")
  );
}

const RELOAD_GUARD_KEY = "scope-error-auto-reloaded";

export default function ScopeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isLikelyDeploySkew(error)) {
      try {
        if (sessionStorage.getItem(RELOAD_GUARD_KEY) !== "1") {
          sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
          window.location.reload();
          return;
        }
      } catch {
        // sessionStorage can throw in locked-down contexts; fall through to the
        // manual retry UI below.
      }
    }
    // Clear the guard on any successful mount that isn't itself a skew reload,
    // so a later, unrelated skew can still auto-recover once.
    try {
      if (!isLikelyDeploySkew(error)) sessionStorage.removeItem(RELOAD_GUARD_KEY);
    } catch {
      // ignore
    }
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center text-center px-6">
      <div className="max-w-sm">
        <h1 className="text-base font-semibold mb-2">Something went wrong</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          This view failed to load. It&apos;s usually a transient hiccup — try
          again, and if it sticks, reload the page.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              try {
                sessionStorage.removeItem(RELOAD_GUARD_KEY);
              } catch {
                // ignore
              }
              reset();
            }}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-brand)] text-white hover:opacity-90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded-md text-sm font-medium border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Reload
          </button>
        </div>
        {error?.digest ? (
          <p className="mt-3 text-[11px] text-neutral-400 dark:text-neutral-600">
            Ref: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
