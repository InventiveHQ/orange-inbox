"use client";

import { useEffect, useState, useTransition } from "react";

type State =
  | "idle"
  | "loading"
  | "subscribed"
  | "denied"
  | "unsupported"
  | "needs_install"
  | "error";

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const win = window as Window & { MSStream?: unknown };
  // Classic UA sniff plus a guard for IE Mobile (which historically spoofed iOS).
  // iPadOS 13+ reports as Mac; `'standalone' in navigator` is the corollary tell.
  const uaMatch = /iPad|iPhone|iPod/.test(ua) && !win.MSStream;
  const standaloneProp = "standalone" in navigator;
  return uaMatch || standaloneProp;
}

function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // Legacy iOS exposes navigator.standalone === true when launched from home screen.
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function b64uToUint8(b64u: string): Uint8Array<ArrayBuffer> {
  const pad = b64u.length % 4 === 0 ? "" : "=".repeat(4 - (b64u.length % 4));
  const bin = atob(b64u.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function PushNotificationToggle() {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    // iOS only delivers Web Push when launched as an installed PWA (iOS 16.4+).
    // The push APIs above are present in regular Safari but won't actually work,
    // so surface a separate "needs_install" state with explicit instructions.
    if (isIOS() && !isStandalonePWA()) {
      setState("needs_install");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          setEndpoint(sub.endpoint);
          setState("subscribed");
        } else {
          setState("idle");
        }
      } catch (e) {
        console.warn("getSubscription failed", e);
        setState("idle");
      }
    })();
  }, []);

  function enable() {
    setError(null);
    startTransition(async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          setState(perm === "denied" ? "denied" : "idle");
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const vapidRes = await fetch("/api/push/vapid");
        if (!vapidRes.ok) throw new Error(`vapid ${vapidRes.status}`);
        const { publicKey } = (await vapidRes.json()) as { publicKey: string };
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64uToUint8(publicKey),
        });
        const subJson = sub.toJSON();
        const r = await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: subJson }),
        });
        if (!r.ok) throw new Error(`subscribe ${r.status}`);
        setEndpoint(sub.endpoint);
        setState("subscribed");
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
          await sub.unsubscribe();
        }
        setEndpoint(null);
        setState("idle");
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3 text-sm flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium">Notifications on this device</div>
        <div className="text-xs text-neutral-500 mt-0.5">
          {state === "unsupported"
            ? "This browser doesn't support web push."
            : state === "needs_install"
              ? "On iOS, push notifications only work after you install orange mail to your home screen. In Safari, tap the Share button → ‘Add to Home Screen’, then open the app from the home-screen icon and try again."
              : state === "denied"
                ? "Blocked. Re-enable notifications for this site in your browser settings."
                : state === "subscribed"
                  ? "Enabled — you'll get a notification on this device when new mail arrives."
                  : "Get a push notification on this device when new mail arrives."}
        </div>
        {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
      </div>
      <div className="shrink-0">
        {state === "subscribed" ? (
          <button
            type="button"
            onClick={disable}
            disabled={pending}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {pending ? "…" : "Disable"}
          </button>
        ) : state === "needs_install" ? null : (
          <button
            type="button"
            onClick={enable}
            disabled={pending || state === "unsupported" || state === "denied" || state === "loading"}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? "Enabling…" : "Enable"}
          </button>
        )}
      </div>
      {endpoint && state === "subscribed" && (
        <span className="sr-only" aria-hidden>
          {endpoint}
        </span>
      )}
    </div>
  );
}
