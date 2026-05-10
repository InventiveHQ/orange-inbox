// Operational alerting.
//
// Posts a structured message to a configurable webhook (Slack-compatible
// JSON shape, also accepted by Discord and most generic webhook services)
// when something goes wrong that the operator should know about.
//
// Configuration: set ALERT_WEBHOOK_URL as a worker secret. Without it,
// notify() reduces to a console.error — the same behavior as before, so
// adding this helper to a code path is always safe.
//
// We deliberately don't retry or queue: the operator's webhook should be
// reliable enough that a single fire-and-forget POST is fine, and we
// don't want an alert path with its own failure mode that could mask
// the underlying problem.

interface NotifyEnv {
  ALERT_WEBHOOK_URL?: string;
}

export type Severity = "warn" | "error" | "fatal";

export async function notify(
  env: NotifyEnv,
  severity: Severity,
  title: string,
  context?: Record<string, unknown>,
): Promise<void> {
  const line = `[${severity.toUpperCase()}] ${title}` +
    (context ? ` ${JSON.stringify(context)}` : "");

  if (severity === "warn") console.warn(line);
  else console.error(line);

  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;

  // Slack-compatible payload. Discord ignores `attachments` but renders
  // the top-level `text` correctly.
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
    // 5s timeout — alerts shouldn't block the request path; if the webhook
    // is slow, the alert is dropped rather than backing up the worker.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5_000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Don't recurse — just log. notify() must never throw.
    console.error("notify webhook failed:", err);
  }
}
