"use client";

// Last-resort boundary. Fires only when an error escapes every nested boundary
// (including a throw in the root layout itself), so it must render its own
// <html>/<body> — the root layout is not mounted when this shows. Kept minimal
// and dependency-free for exactly that reason: whatever broke, this should not.

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A bundle/RSC mismatch after a deploy can take out the whole tree before
    // any inner boundary mounts. One guarded hard reload pulls the new build.
    const msg = `${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();
    const skew =
      msg.includes("rsc payload") ||
      msg.includes("dynamically imported module") ||
      msg.includes("loading chunk") ||
      msg.includes("chunkloaderror");
    if (!skew) return;
    try {
      if (sessionStorage.getItem("global-error-auto-reloaded") !== "1") {
        sessionStorage.setItem("global-error-auto-reloaded", "1");
        window.location.reload();
      }
    } catch {
      // ignore
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#fafafa",
          color: "#171717",
        }}
      >
        <div style={{ maxWidth: 360, textAlign: "center", padding: "0 24px" }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            Orange Inbox hit a snag
          </h1>
          <p style={{ fontSize: 14, color: "#525252", margin: "0 0 16px" }}>
            The app failed to load. This is usually fixed by reloading.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "none",
              fontSize: 14,
              fontWeight: 500,
              background: "#f38020",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
