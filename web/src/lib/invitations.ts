import { getDb, getEnv } from "./db";

interface SendInvitationArgs {
  /** uuid of the inviting user (for the From-attribution + display). */
  inviterId: string;
  /** Email address of the new user being invited. */
  inviteeEmail: string;
  /** Mailbox they were just granted access to. */
  mailboxId: string;
  /** Their role on that mailbox. */
  role: "owner" | "member" | "reader";
}

interface InvitationContext {
  inviterEmail: string;
  inviterDisplay: string;
  mailboxAddress: string;
  mailboxDisplay: string;
}

// Best-effort transactional notification when a not-yet-signed-in user is
// added to a mailbox. The send may fail when the invitee isn't a verified
// destination in the inviter's Cloudflare Email Routing setup — that's
// inherent to the platform; we surface a structured warning instead of
// failing the underlying invite.
export async function sendInvitationEmail(args: SendInvitationArgs): Promise<void> {
  const env = getEnv();
  const ctx = await loadContext(args);
  if (!ctx) return; // shouldn't happen; loadContext returns null only if data has gone

  const subject = `${ctx.inviterDisplay} invited you to ${ctx.mailboxDisplay}`;
  const text = renderText(ctx, args.role);
  const html = renderHtml(ctx, args.role);

  try {
    await env.EMAIL.send({
      from: ctx.mailboxAddress,
      to: args.inviteeEmail,
      subject,
      text,
      html,
    });
  } catch (e) {
    // The Cloudflare send_email binding only delivers to verified
    // destinations. New invitees are by definition unverified, so this
    // is expected to fail more often than not until the user adds their
    // teammate as a destination first. Log loudly so the inviter can
    // intervene; don't propagate.
    console.warn("invitation send failed", {
      inviteeEmail: args.inviteeEmail,
      mailboxId: args.mailboxId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function loadContext(args: SendInvitationArgs): Promise<InvitationContext | null> {
  const db = getDb();
  const inviter = await db
    .prepare("SELECT email, display_name FROM users WHERE id = ?")
    .bind(args.inviterId)
    .first<{ email: string; display_name: string | null }>();
  if (!inviter) return null;

  const mailbox = await db
    .prepare(
      `SELECT mb.local_part, mb.display_name AS mailbox_display, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE mb.id = ?`,
    )
    .bind(args.mailboxId)
    .first<{ local_part: string; mailbox_display: string | null; domain_name: string }>();
  if (!mailbox) return null;

  const mailboxAddress = `${mailbox.local_part}@${mailbox.domain_name}`;
  return {
    inviterEmail: inviter.email,
    inviterDisplay: inviter.display_name?.trim() || inviter.email,
    mailboxAddress,
    mailboxDisplay: mailbox.mailbox_display?.trim() || mailboxAddress,
  };
}

function renderText(ctx: InvitationContext, role: SendInvitationArgs["role"]): string {
  return [
    `Hi,`,
    ``,
    `${ctx.inviterDisplay} (${ctx.inviterEmail}) added you as ${roleLabel(role)} on the`,
    `mailbox ${ctx.mailboxDisplay} (${ctx.mailboxAddress}).`,
    ``,
    `When you next sign into orange-inbox you'll see this mailbox in your sidebar.`,
    ``,
    `If you're not expecting this, you can ignore the message — no further action`,
    `is taken until you sign in.`,
  ].join("\n");
}

function renderHtml(ctx: InvitationContext, role: SendInvitationArgs["role"]): string {
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
<p>Hi,</p>
<p><strong>${escapeHtml(ctx.inviterDisplay)}</strong> (${escapeHtml(ctx.inviterEmail)}) added you as
<strong>${roleLabel(role)}</strong> on the mailbox <strong>${escapeHtml(ctx.mailboxDisplay)}</strong>
(${escapeHtml(ctx.mailboxAddress)}).</p>
<p>When you next sign into orange-inbox you'll see this mailbox in your sidebar.</p>
<p style="color:#666;font-size:13px;">If you're not expecting this, you can ignore the message — no further action is taken until you sign in.</p>
</body></html>`;
}

function roleLabel(role: SendInvitationArgs["role"]): string {
  if (role === "owner") return "an owner";
  if (role === "member") return "a member";
  return "a reader";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
