// Inbound mail handler. Cloudflare Email Routing dispatches each message here.
// Stage 2 will fill in: postal-mime parse → R2 raw .eml + attachments → D1 thread/message.

interface Env {
  DB: D1Database;
  RAW_MAIL: R2Bucket;
  ATTACHMENTS: R2Bucket;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const rawKey = `incoming/${Date.now()}-${crypto.randomUUID()}.eml`;
    await env.RAW_MAIL.put(rawKey, message.raw, {
      customMetadata: {
        from: message.from,
        to: message.to,
        size: String(message.rawSize),
      },
    });

    console.log(`stored ${rawKey} (${message.rawSize} bytes) from=${message.from} to=${message.to}`);
  },
} satisfies ExportedHandler<Env>;
