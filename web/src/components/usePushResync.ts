"use client";

import { useEffect } from "react";

// Re-registers the Web Push subscription with the server on every app launch.
//
// iOS rotates/expires push subscriptions (especially after a PWA has sat
// unused) and does *not* reliably fire the service worker's
// `pushsubscriptionchange` event. Without a backstop the server keeps a dead
// endpoint, the push service returns 404/410, the row gets pruned, and
// notifications stop for good — even though the user never touched the
// toggle.
//
// This hook runs once per launch. It is deliberately conservative:
//   • It never prompts — it only acts when Notification.permission is already
//     "granted", so it can't surface a permission dialog the user didn't ask
//     for.
//   • When a subscription exists it just re-POSTs it (the /api/push/subscribe
//     endpoint is an idempotent upsert — re-subscribing the same endpoint
//     refreshes the stored keys).
//   • When permission is granted but the subscription is gone (the OS dropped
//     it), it re-creates one with the server's VAPID key.
//
// Paired with the SW `pushsubscriptionchange` handler — one of the two will
// land on any given engine.

// Returns Uint8Array<ArrayBuffer> (not ArrayBufferLike) so it satisfies the
// BufferSource constraint on pushManager.subscribe's applicationServerKey —
// same shape as the helper in PushNotificationToggle.
function b64uToUint8(b64u: string): Uint8Array<ArrayBuffer> {
  const pad = b64u.length % 4 === 0 ? "" : "=".repeat(4 - (b64u.length % 4));
  const bin = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function usePushResync(): void {
  useEffect(() => {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      return;
    }
    // Only touch existing grants — never prompt from here.
    if (Notification.permission !== "granted") return;

    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          // Permission granted but no subscription — the OS dropped it.
          const vapidRes = await fetch("/api/push/vapid");
          if (!vapidRes.ok || cancelled) return;
          const { publicKey } = (await vapidRes.json()) as { publicKey: string };
          if (cancelled) return;
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64uToUint8(publicKey),
          });
        }
        if (cancelled) return;
        // Idempotent upsert — refreshes the endpoint/keys the server stores.
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch {
        // Best-effort — the SW `pushsubscriptionchange` handler is the other
        // half of this; failing here is not worth surfacing to the user.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
