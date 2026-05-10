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
  // RFC 2369 / 8058 newsletter unsubscribe metadata. Populated from
  // List-Unsubscribe + List-Unsubscribe-Post when the inbound message is a
  // mailing-list / newsletter; otherwise all three are empty/false. The
  // store layer persists these on the messages row so listing + the
  // Subscriptions aggregation can query them without re-parsing headers.
  listUnsubUrl: string | null;
  listUnsubMailto: string | null;
  listUnsubOneClick: boolean;
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  disposition: "attachment" | "inline" | null;
  contentId?: string;
  bytes: ArrayBuffer;
}
