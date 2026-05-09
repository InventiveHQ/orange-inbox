import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

// Landing page for `mailto:` protocol handler clicks, Android share-target
// intents, and the "Compose" PWA shortcut. We don't actually render anything
// here — the inbox layout owns the ComposeProvider, so this server page
// normalises whatever inputs we received into a uniform set of query params
// (`compose=1` + `to`/`cc`/`subject`/`body`) and redirects into
// `/inbox/all`. A small client component mounted inside the inbox layout
// (`ComposeFromUrl`) picks those up on mount, opens the composer, and strips
// the params from the URL.
//
// Auth-gating: calling `requireUser()` first means an unauthenticated user
// hits Cloudflare Access (in production) or the dev-mode sign-in prompt
// before we redirect; otherwise the redirect target itself would also be
// gated, but the user's intent (the recipient/subject/body they clicked)
// would be lost across the auth bounce.

interface ComposeFields {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

// Parse a `mailto:` URI into compose fields. Inputs look like:
//   mailto:foo@example.com
//   mailto:a@x.com,b@y.com?cc=c@z.com&subject=Hi&body=Hey
// Per RFC 6068 the recipient list sits between `mailto:` and the optional
// `?` query, comma-separated. We use `URL` for the query parsing; it
// happily accepts the `mailto:` scheme and exposes `searchParams`.
function parseMailto(raw: string): ComposeFields {
  if (!raw) return {};
  let trimmed = raw.trim();
  if (!/^mailto:/i.test(trimmed)) {
    // Some clients (and the protocol_handlers spec on certain platforms)
    // pass the bare address without the scheme. Tolerate that.
    trimmed = `mailto:${trimmed}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {};
  }
  // For `mailto:`, `pathname` holds the percent-encoded recipient list.
  const recipientsRaw = decodeURIComponent(url.pathname || "");
  const to = recipientsRaw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const out: ComposeFields = {};
  if (to.length > 0) out.to = to;

  const sp = url.searchParams;
  // Header names in `mailto:` queries are case-insensitive per RFC 6068.
  const lookup = (name: string): string | null => {
    for (const [k, v] of sp.entries()) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  };
  const cc = lookup("cc");
  if (cc) {
    out.cc = cc
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
  const bcc = lookup("bcc");
  if (bcc) {
    out.bcc = bcc
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
  const subject = lookup("subject");
  if (subject) out.subject = subject;
  const body = lookup("body");
  if (body) out.body = body;
  return out;
}

function splitAddrs(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

// Coerce a searchParam value (string | string[] | undefined) to a single
// string. Next gives us arrays for repeated keys; we only ever care about
// the first occurrence here.
function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;

  // 1) Start from any explicit fields on the query.
  const fields: ComposeFields = {
    to: splitAddrs(first(sp.to)),
    cc: splitAddrs(first(sp.cc)),
    subject: first(sp.subject),
    body: first(sp.body),
  };

  // 2) Layer on `mailto=` (from the protocol handler). `mailto:` fields
  //    take precedence over bare query fields when both are present, on
  //    the theory that the user's click on a `mailto:` link is the
  //    higher-fidelity signal.
  const mailtoRaw = first(sp.mailto);
  if (mailtoRaw) {
    const m = parseMailto(mailtoRaw);
    if (m.to && m.to.length > 0) fields.to = m.to;
    if (m.cc && m.cc.length > 0) fields.cc = m.cc;
    if (m.subject !== undefined) fields.subject = m.subject;
    if (m.body !== undefined) fields.body = m.body;
  }

  // 3) Android share-target shape: `title` -> subject, `text` -> body,
  //    `url` -> appended to body. Only fill what's still empty so an
  //    explicit `subject=` query param wins over a `title=` from a share.
  const title = first(sp.title);
  const text = first(sp.text);
  const url = first(sp.url);
  if (title && !fields.subject) fields.subject = title;
  if (text && !fields.body) fields.body = text;
  if (url) {
    const body = fields.body ?? "";
    if (!body.includes(url)) {
      fields.body = body ? `${body}\n${url}` : url;
    }
  }

  // Build the redirect target. We URL-encode each value and omit empties so
  // `ComposeFromUrl` doesn't have to special-case blank fields.
  const target = new URLSearchParams();
  target.set("compose", "1");
  if (fields.to && fields.to.length > 0) target.set("to", fields.to.join(","));
  if (fields.cc && fields.cc.length > 0) target.set("cc", fields.cc.join(","));
  if (fields.subject) target.set("subject", fields.subject);
  if (fields.body) target.set("body", fields.body);

  redirect(`/inbox/all?${target.toString()}`);
}
