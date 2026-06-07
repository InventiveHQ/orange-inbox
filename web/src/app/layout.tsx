import type { Metadata, Viewport } from "next";
import { Geist, Fraunces } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import PWAClient from "@/components/PWAClient";
import {
  DEFAULT_PREFERENCES,
  PREFS_COOKIE,
  decodePreferencesCookie,
} from "@/lib/preferences";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Display face for brand-bearing surfaces only — the wordmark and empty-state
// headlines — wired through `--font-display` (see globals.css @theme inline,
// utility `font-display`). Geist still owns all body/UI text; Fraunces is a
// warm optical-sized serif that gives those few brand moments character
// without touching the dense list legibility Geist handles well. `opsz` is
// exposed so headlines can lean into the high-contrast display cut.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
});

export const metadata: Metadata = {
  title: "Orange Inbox",
  description: "Gmail-like webmail on Cloudflare",
  applicationName: "Orange Inbox",
  // manifest link is rendered manually below with crossOrigin="use-credentials"
  // so the browser sends the Cloudflare Access cookie when fetching it.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Orange Inbox",
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
};

export const viewport: Viewport = {
  themeColor: "#f38020",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the appearance preferences cookie (synced from D1 on login + on
  // every PATCH from Settings → Appearance). Falls back to defaults so the
  // first paint is well-defined even pre-login or after the cookie expires.
  // We deliberately *don't* hit D1 here — that would tax every request and
  // delay first paint; the cookie is the canonical SSR source.
  const cookieStore = await cookies();
  const prefs =
    decodePreferencesCookie(cookieStore.get(PREFS_COOKIE)?.value) ?? DEFAULT_PREFERENCES;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${fraunces.variable} h-full antialiased`}
      data-theme={prefs.theme}
      data-density={prefs.density}
      style={{ ["--brand" as string]: prefs.accent_hex }}
    >
      <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      <body className="min-h-full bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 font-sans">
        {children}
        <PWAClient />
      </body>
    </html>
  );
}
