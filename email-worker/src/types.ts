export interface Env {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  ATTACHMENTS: R2Bucket;
  // Service binding to the web Worker (dispatching scheduled sends).
  WEB?: { fetch: (request: Request) => Promise<Response> };
  INTERNAL_SECRET?: string;
  // Optional Slack-compatible webhook for operational alerts. Set via
  // `wrangler secret put ALERT_WEBHOOK_URL` to enable; unset = no-op.
  ALERT_WEBHOOK_URL?: string;
  // The authserv-id our trusted MX (Cloudflare) stamps into the
  // Authentication-Results header it prepends — i.e. the token before the
  // first `;` in that header. parse.ts pins auth-results selection to this
  // value so an attacker-embedded Authentication-Results header is ignored.
  // Empty/unset = fall back to "only the first header" (Cloudflare prepends).
  TRUSTED_AUTHSERV_ID?: string;
}

export interface AddressInfo {
  addr: string;
  name?: string;
}

// Normalized shape we hand around internally — postal-mime's Email type with
// the parts we don't use stripped out and addresses flattened.
export interface ParsedMessage {
  messageId: string;
  inReplyTo?: string;
  references: string[];
  from: AddressInfo;
  to: AddressInfo[];
  cc: AddressInfo[];
  bcc: AddressInfo[];
  subject: string;
  date: number;
  text?: string;
  html?: string;
  snippet: string;
  attachments: ParsedAttachment[];
  // Anti-loop signals lifted from raw headers (RFC 3834). The auto-responder
  // consults these to decide whether the inbound looks automated; if so it
  // stays quiet rather than amplifying a mail loop.
  autoSubmitted: string | null; // raw value of "Auto-Submitted" header, lowercased
  precedence: string | null;    // raw value of "Precedence" header, lowercased
  hasListHeaders: boolean;      // true if any List-* header is present
  hasListId: boolean;           // true if a List-Id header is present (mailing-list / forum)
  // 0018: trust signals. Both populated by parse.ts; first_contact is
  // computed at store-time so it isn't on this type.
  authResults: ParsedAuthResults | null;
  // Bare reply-to address (lowercased, no display name) ONLY when it
  // differs from from.addr; null otherwise. Caller stores verbatim.
  replyToAddr: string | null;
  // RFC 2369 / 8058 newsletter unsubscribe metadata. Populated from
  // List-Unsubscribe + List-Unsubscribe-Post when the inbound message is a
  // mailing-list / newsletter; otherwise all three are empty/false. The
  // store layer persists these on the messages row so listing + the
  // Subscriptions aggregation can query them without re-parsing headers.
  listUnsubUrl: string | null;
  listUnsubMailto: string | null;
  listUnsubOneClick: boolean;
  // 0031: two-axis triage classifier (#3, #7). Populated by parse.ts via
  // triage.classify() over the headers-only signals. The store layer can
  // re-classify with additional per-user context (VIP, contacts, mailbox
  // ownership) before persisting.
  isMarketing: boolean;
  isActionItem: boolean;
}

// Parsed Authentication-Results, kept as a small JSON-friendly shape
// so we can stringify directly into the messages.auth_results column.
export interface ParsedAuthResults {
  spf: string;
  dkim: string;
  dmarc: string;
  from_domain: string | null;
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  disposition: "attachment" | "inline" | null;
  contentId?: string;
  bytes: ArrayBuffer;
  // Tagged at parse time via attachment-safety.ts. The web UI uses this to
  // render a warning badge and gate the download behind an explicit confirm.
  isExecutable: boolean;
}
