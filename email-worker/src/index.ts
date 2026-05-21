import { runCron } from "./cron";
import { notify } from "./notify";
import { parseEmail } from "./parse";
import { resolveRecipient } from "./route";
import { storeMessage } from "./store";
import { findOrCreateThread } from "./thread";
import type { Env } from "./types";

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    try {
      const recipient = await resolveRecipient(env, message.to);
      if (!recipient) {
        message.setReject(`Unknown mailbox: ${message.to}`);
        return;
      }

      // Tee so we can both parse the stream and capture raw bytes for R2.
      const [forParse, forRaw] = message.raw.tee();
      const rawBytes = await new Response(forRaw).arrayBuffer();

      const parsed = await parseEmail(forParse, env.TRUSTED_AUTHSERV_ID);
      const thread = await findOrCreateThread(env, recipient.mailboxId, parsed);
      const result = await storeMessage(env, ctx, recipient, thread, parsed, rawBytes);

      console.log(
        `inbound ${result.duplicate ? "(dup)" : "ok"} mailbox=${recipient.mailboxId} ` +
          `thread=${result.threadId} msg=${result.messageId} from=${parsed.from.addr}`,
      );
    } catch (err) {
      // Mail ingestion failed — page the operator. Re-throw so Cloudflare
      // sees the failure and the upstream MX retries the delivery.
      ctx.waitUntil(
        notify(env, "error", "Inbound email failed", {
          to: message.to,
          from: message.from,
          error: errToString(err),
        }),
      );
      throw err;
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    try {
      await runCron(env, ctx);
    } catch (err) {
      ctx.waitUntil(
        notify(env, "error", "Cron tick failed", { error: errToString(err) }),
      );
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

function errToString(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack ?? ""}`.slice(0, 2000);
  return String(e).slice(0, 2000);
}
