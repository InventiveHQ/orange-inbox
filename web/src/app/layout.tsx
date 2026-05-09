import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import PWAClient from "@/components/PWAClient";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "orange inbox",
  description: "Gmail-like webmail on Cloudflare",
  applicationName: "orange mail",
  // manifest link is rendered manually below with crossOrigin="use-credentials"
  // so the browser sends the Cloudflare Access cookie when fetching it.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "orange mail",
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      <body className="min-h-full bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 font-sans">
        {children}
        <PWAClient />
      </body>
    </html>
  );
}
