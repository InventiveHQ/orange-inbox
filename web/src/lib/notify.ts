// Operational alerting for the web worker — mirror of the helper in
// email-worker/src/notify.ts. Kept as a small standalone module so the
// two workers don't need to share code.
//
// Configuration: set ALERT_WEBHOOK_URL as a worker secret. Without it,
// notify() reduces to a console.error.

export type Severity = "warn" | "error" | "fatal";

export async function notify(
  webhookUrl: string | undefined,
  severity: Severity,
  title: string,
  context?: Record<string, unknown>,
): Promise<void> {
  const line = `[${severity.toUpperCase()}] ${title}` +
    (context ? ` ${JSON.stringify(context)}` : "");

  if (severity === "warn") console.warn(line);
  else console.error(line);

  if (!webhookUrl) return;

  const emoji = severity === "warn" ? "⚠️" : severity === "error" ? "🟥" : "🔥";
  const body = JSON.stringify({
    text: `${emoji} *orange-inbox* — ${title}`,
    attachments: context
      ? [
          {
            color: severity === "warn" ? "#f59e0b" : "#ef4444",
            fields: Object.entries(context).map(([key, value]) => ({
              title: key,
              value: typeof value === "string" ? value : JSON.stringify(value),
              short: true,
            })),
          },
        ]
      : undefined,
  });

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5_000);
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("notify webhook failed:", err);
  }
}
