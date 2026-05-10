"use client";

// Tiny client for round-tripping postMessage calls with the active service
// worker. All entry points are no-ops when there's no controller (SW not yet
// registered, or no-SW environment like next dev with HTTP) so callers can
// treat these as fire-and-forget without guards.

// Subset of the outbox row shape we care about on the page side. Mirror of
// what the SW writes into IndexedDB; only the fields the UI consumes are
// surfaced here.
export interface OutboxRow {
  id: number;
  createdAt: number;
  // The composer's verbatim /api/messages POST body. Re-typed as unknown
  // because the SW doesn't validate it — the server is the source of truth.
  payload: unknown;
  status: "pending" | "sending" | "sent" | "failed";
  lastError: string | null;
  attempts: number;
}

export interface FlushDoneEvent {
  type: "outbox-flush-done";
  reason: string;
  sent: number;
  failed: number;
  remaining: number;
}

export interface FlushStartEvent {
  type: "outbox-flush-start";
  reason: string;
  total: number;
}

export interface FlushProgressEvent {
  type: "outbox-flush-progress";
  id: number;
  status: "sent" | "failed" | "deferred";
  error?: string;
}

export type SwOutboxEvent = FlushStartEvent | FlushProgressEvent | FlushDoneEvent;

function controller(): ServiceWorker | null {
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.controller;
}

export function isSwAvailable(): boolean {
  return controller() !== null;
}

// Ask the SW to enqueue a payload in IndexedDB. Resolves to the row id once
// the SW acks (best-effort — if the SW is missing or doesn't ack within
// 2 s, resolves null and the caller should treat the queue as unavailable).
export function queueSend(payload: unknown): Promise<number | null> {
  const sw = controller();
  if (!sw) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const channel = new MessageChannel();
    const cleanup = () => {
      channel.port1.close();
      navigator.serviceWorker.removeEventListener("message", onWindowMessage);
    };
    const finish = (id: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(id);
    };
    channel.port1.onmessage = ev => {
      const data = ev.data as { type?: string; id?: number };
      if (data?.type === "queue-send-ack") finish(typeof data.id === "number" ? data.id : null);
    };
    // Some SW message paths reply via source.postMessage on the global
    // serviceWorker (rather than via the explicit MessagePort). Listen on
    // both so we don't miss the ack on first-load when the controller is
    // freshly minted.
    const onWindowMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; id?: number };
      if (data?.type === "queue-send-ack") finish(typeof data.id === "number" ? data.id : null);
    };
    navigator.serviceWorker.addEventListener("message", onWindowMessage);
    try {
      sw.postMessage({ type: "queue-send", payload }, [channel.port2]);
    } catch {
      // Posting a MessagePort can fail on stale controllers; fall back.
      sw.postMessage({ type: "queue-send", payload });
    }
    setTimeout(() => finish(null), 2_000);
  });
}

// Ask the SW to drain the queue. Idempotent — the SW guards against
// concurrent flushes.
export function flushOutbox(reason = "manual"): void {
  controller()?.postMessage({ type: "flush-outbox", reason });
}

// Subscribe to outbox lifecycle events. Returns an unsubscribe fn.
export function onOutboxEvent(handler: (ev: SwOutboxEvent) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const listener = (ev: MessageEvent) => {
    const data = ev.data as { type?: string };
    if (!data?.type) return;
    if (
      data.type === "outbox-flush-start" ||
      data.type === "outbox-flush-progress" ||
      data.type === "outbox-flush-done"
    ) {
      handler(data as SwOutboxEvent);
    }
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

// Snapshot of the outbox for diagnostics / debugging — surfaces every row
// regardless of status. Resolves [] if the SW doesn't respond within 2 s.
export function listOutbox(): Promise<OutboxRow[]> {
  const sw = controller();
  if (!sw) return Promise.resolve([]);
  return new Promise(resolve => {
    let settled = false;
    const finish = (rows: OutboxRow[]) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(rows);
    };
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; rows?: OutboxRow[] };
      if (data?.type === "outbox-list") finish(data.rows ?? []);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    sw.postMessage({ type: "list-outbox" });
    setTimeout(() => finish([]), 2_000);
  });
}
