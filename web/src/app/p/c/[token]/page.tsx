import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import ConfidentialViewer from "./ConfidentialViewer";

// Public confidential-message view (#66). Reachable WITHOUT authentication —
// the URL token is the only credential. It lives under /p/*, the prefix the
// operator exempts with a single Cloudflare Access Bypass policy; Access
// must NOT gate /p/*.
//
// SSR responsibilities:
//   1. Look up the confidential_messages row by token.
//   2. Reject anything that doesn't pass /^[A-Za-z0-9_-]{8,}$/ — the token
//      shape is hard-coded in send.ts (22 base64url chars), but we accept
//      anything plausible to keep the path bug-tolerant.
//   3. Return a clear 410 / message-not-found page when the row is expired,
//      revoked, or missing. Never leak that the *id* exists if it's expired.
//   4. If a passcode is set, render the passcode form (client component) and
//      let it POST against /p/api/confidential/<token> before revealing the
//      body.
//
// We do NOT increment `views` here. The increment happens on the route POST
// (passcode-protected path) or as a server action invoked from the viewer
// once the body is rendered (non-passcode path). Keeping the SSR query a
// pure read keeps double-fetches from inflating the count.

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

interface Row {
  id: string;
  body_text: string;
  body_html: string | null;
  expires_at: number;
  view_passcode: string | null;
  views: number;
  revoked: number;
}

export default async function ConfidentialPage({ params }: PageProps) {
  const { token } = await params;
  if (!token || !/^[A-Za-z0-9_-]{8,}$/.test(token)) {
    return notFound();
  }

  const row = await getDb()
    .prepare(
      `SELECT id, body_text, body_html, expires_at, view_passcode, views, revoked
         FROM confidential_messages
        WHERE id = ?`,
    )
    .bind(token)
    .first<Row>();

  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked === 1 || row.expires_at <= now) {
    // 410 Gone semantics — but Next 16 page renders can't set arbitrary
    // status codes from the page itself. The user-visible outcome is the
    // same (a clean "no longer available" page). External crawlers and
    // bots aren't a concern here; the URL was only ever shared via email.
    return <ExpiredPage />;
  }

  const requiresPasscode = !!row.view_passcode;

  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6">
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-100 dark:bg-blue-900/30 px-3 py-1 text-xs font-medium text-blue-800 dark:text-blue-300">
            <span aria-hidden>🔒</span>
            Confidential message
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            This message wasn&apos;t delivered to your mailbox — it lives only at this URL and
            expires {formatExpiry(row.expires_at)}. Don&apos;t forward the link.
          </p>
        </header>
        <ConfidentialViewer
          token={row.id}
          requiresPasscode={requiresPasscode}
          // When there's no passcode, the body is already trustable to ship
          // server-side — the token guarded access. The viewer renders it
          // and pings /p/api/confidential/<token> with action=view to bump the
          // view counter.
          initialBodyText={requiresPasscode ? null : row.body_text}
          initialBodyHtml={requiresPasscode ? null : row.body_html}
        />
      </div>
    </main>
  );
}

function ExpiredPage() {
  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-md text-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          <span aria-hidden>⏳</span>
          No longer available
        </div>
        <h1 className="mt-4 text-lg font-semibold">This confidential link has expired</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          The sender set a time limit on this message, or has revoked access. Ask them to
          resend if you still need it.
        </p>
      </div>
    </main>
  );
}

function formatExpiry(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
