import type { MetadataRoute } from "next";

// Next's `MetadataRoute.Manifest` type lags the spec — `protocol_handlers`,
// `share_target`, `launch_handler`, and `display_override` aren't all typed.
// We cast through a permissive shape so we can ship spec-compliant fields
// without downgrading the manifest just to satisfy the compiler. The
// browser, not TypeScript, is the consumer here.
type ExtendedManifest = MetadataRoute.Manifest & Record<string, unknown>;

export default function manifest(): MetadataRoute.Manifest {
  const m: ExtendedManifest = {
    id: "/",
    name: "Orange Inbox",
    short_name: "Orange",
    description: "Gmail-like webmail on Cloudflare",
    categories: ["productivity", "communication"],
    lang: "en",
    dir: "ltr",
    start_url: "/inbox/all",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#f38020",
    prefer_related_applications: false,
    launch_handler: { client_mode: "navigate-existing" },
    protocol_handlers: [{ protocol: "mailto", url: "/compose?mailto=%s" }],
    share_target: {
      action: "/compose",
      method: "GET",
      params: { title: "subject", text: "body", url: "url" },
    },
    shortcuts: [
      { name: "Compose", short_name: "Compose", url: "/compose" },
      { name: "Starred", short_name: "Starred", url: "/inbox/starred" },
      { name: "All mail", short_name: "All", url: "/inbox/all" },
    ],
    icons: [
      // Maskable variant intentionally omitted — the existing 512 icon has no
      // safe-zone padding, so Android crops into the logo. Re-add once a
      // properly-padded image is supplied.
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
  return m as MetadataRoute.Manifest;
}
