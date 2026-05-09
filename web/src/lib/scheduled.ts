import { getDb } from "./db";

export interface ScheduledRow {
  id: string;
  user_id: string;
  scheduled_for: number;
  status: "pending" | "sent" | "failed" | "cancelled";
  error_message: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface ScheduledRowWithSummary extends ScheduledRow {
  // Pulled out of payload_json for list rendering.
  to_summary: string;
  subject: string;
}

export async function listScheduledForUser(
  userId: string,
  opts: { includeFinal?: boolean } = {},
): Promise<ScheduledRowWithSummary[]> {
  // kind='undo_send' rows are transient (5–30s) and only ever surfaced through
  // the compose-time toast, so they're filtered out of the Scheduled view.
  const where = opts.includeFinal
    ? "user_id = ? AND kind = 'scheduled'"
    : "user_id = ? AND status = 'pending' AND kind = 'scheduled'";
  const { results } = await getDb()
    .prepare(
      `SELECT id, user_id, scheduled_for, payload_json, status, error_message, created_at, sent_at
         FROM scheduled_messages
        WHERE ${where}
        ORDER BY scheduled_for ASC`,
    )
    .bind(userId)
    .all<ScheduledRow & { payload_json: string }>();

  return (results ?? []).map(r => {
    let to_summary = "";
    let subject = "";
    try {
      const p = JSON.parse(r.payload_json) as { to?: string[]; subject?: string };
      to_summary = (p.to ?? []).slice(0, 2).join(", ");
      if ((p.to ?? []).length > 2) to_summary += ` +${(p.to ?? []).length - 2}`;
      subject = p.subject ?? "";
    } catch {
      // ignore — list still functional with empty preview
    }
    const { payload_json: _drop, ...rest } = r;
    return { ...rest, to_summary, subject };
  });
}
