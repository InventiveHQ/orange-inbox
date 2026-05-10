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
  // 0018: trust signals. Both populated by parse.ts; first_contact is
  // computed at store-time so it isn't on this type.
  authResults: ParsedAuthResults | null;
  // Bare reply-to address (lowercased, no display name) ONLY when it
  // differs from from.addr; null otherwise. Caller stores verbatim.
  replyToAddr: string | null;
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
}
