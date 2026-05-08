import { runCron } from "./cron";
import { parseEmail } from "./parse";
import { resolveRecipient } from "./route";
import { storeMessage } from "./store";
import { findOrCreateThread } from "./thread";
import type { Env } from "./types";

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const recipient = await resolveRecipient(env, message.to);
    if (!recipient) {
      message.setReject(`Unknown mailbox: ${message.to}`);
      return;
    }

    // Tee so we can both parse the stream and capture raw bytes for R2.
    const [forParse, forRaw] = message.raw.tee();
    const rawBytes = await new Response(forRaw).arrayBuffer();

    const parsed = await parseEmail(forParse);
    const thread = await findOrCreateThread(env, recipient.mailboxId, parsed);
    const result = await storeMessage(env, recipient, thread, parsed, rawBytes);

    console.log(
      `inbound ${result.duplicate ? "(dup)" : "ok"} mailbox=${recipient.mailboxId} ` +
        `thread=${result.threadId} msg=${result.messageId} from=${parsed.from.addr}`,
    );
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await runCron(env, ctx);
  },
} satisfies ExportedHandler<Env>;
