export interface Env {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  ATTACHMENTS: R2Bucket;
  // Service binding to the web Worker (dispatching scheduled sends).
  WEB?: { fetch: (request: Request) => Promise<Response> };
  INTERNAL_SECRET?: string;
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
}

export interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  disposition: "attachment" | "inline" | null;
  contentId?: string;
  bytes: ArrayBuffer;
}
