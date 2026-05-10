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
  // Anti-loop signals lifted from raw headers (RFC 3834). The auto-responder
  // consults these to decide whether the inbound looks automated; if so it
  // stays quiet rather than amplifying a mail loop.
  autoSubmitted: string | null; // raw value of "Auto-Submitted" header, lowercased
  precedence: string | null;    // raw value of "Precedence" header, lowercased
  hasListHeaders: boolean;      // true if any List-* header is present
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
