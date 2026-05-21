"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Service-worker update plumbing — modeled after omnicanvasnotes'
// usePWAUpdate (which wraps vite-plugin-pwa's registerSW). We don't have
// that plugin in the Next.js stack, so this hook talks to the SW lifecycle
// directly:
//
//   • Registers /sw.js on mount.
//   • Watches for an installing/waiting worker. If a new SW becomes
//     'installed' while another SW is already controlling the page, that's
//     an update — we surface needRefresh so the UI can show a toast.
//   • checkForUpdate() forces reg.update() and resolves true if a new SW
//     is now waiting (10 s cap).
//   • applyUpdate() posts SKIP_WAITING and reloads.
//
// We deliberately never auto-reload the page on our own. The deploy script
// bumps the SW version on *every* deploy, so an auto-reload would yank the
// page out from under a returning user mid-launch — which reads as "the app
// just closed itself". The toast is a one-tap, place-preserving opt-in
// instead; the only reload we trigger is the one the user asked for via
// applyUpdate().

export interface PWAUpdate {
  needRefresh: boolean;
  applyUpdate: () => void;
  dismiss: () => void;
  checkForUpdate: () => Promise<boolean>;
  supported: boolean;
}

export default function usePWAUpdate(): PWAUpdate {
  const [needRefresh, setNeedRefresh] = useState(false);
  const needRefreshRef = useRef(false);
  const onNeedRefreshResolve = useRef<(() => void) | null>(null);
  // True once applyUpdate() has fired. The controllerchange listener only
  // reloads when this is set — so a SW *claiming* the page for the first
  // time (its own controllerchange) doesn't trigger a spurious reload.
  const updateInitiatedRef = useRef(false);
  const supported =
    typeof window !== "undefined" && "serviceWorker" in navigator;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;

    const trackInstalling = (sw: ServiceWorker) => {
      sw.addEventListener("statechange", () => {
        if (cancelled) return;
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          showRefreshPrompt();
        }
      });
    };

    // A new SW finished installing while an old one still controls the page.
    // Surface the toast and let the user decide — never reload on our own.
    const showRefreshPrompt = () => {
      needRefreshRef.current = true;
      setNeedRefresh(true);
      onNeedRefreshResolve.current?.();
      onNeedRefreshResolve.current = null;
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (cancelled) return;
        if (reg.waiting && navigator.serviceWorker.controller) showRefreshPrompt();
        if (reg.installing) trackInstalling(reg.installing);
        reg.addEventListener("updatefound", () => {
          if (reg.installing) trackInstalling(reg.installing);
        });
      })
      .catch((e) => console.warn("sw registration failed", e));

    let reloading = false;
    const onCtrlChange = () => {
      // Only reload when the user opted into the update via applyUpdate().
      // controllerchange also fires the first time a freshly-installed SW
      // claims the page — reloading on that is a pointless flash.
      if (!updateInitiatedRef.current || reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onCtrlChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onCtrlChange);
    };
  }, [supported]);

  const applyUpdate = useCallback(() => {
    updateInitiatedRef.current = true;
    try {
      sessionStorage.setItem("orange_pre_update_path", window.location.pathname + window.location.search);
    } catch {}
    navigator.serviceWorker?.getRegistration().then((reg) => {
      if (reg?.waiting) {
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
        // controllerchange triggers reload; fall back if it doesn't fire.
        setTimeout(() => window.location.reload(), 1500);
      } else {
        window.location.reload();
      }
    });
  }, []);

  const dismiss = useCallback(() => setNeedRefresh(false), []);

  const checkForUpdate = useCallback(async (): Promise<boolean> => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return false;
    await reg.update();
    if (needRefreshRef.current) return true;
    if (reg.waiting) return true;
    const installing = reg.installing;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (val: boolean) => {
        if (settled) return;
        settled = true;
        onNeedRefreshResolve.current = null;
        resolve(val);
      };
      onNeedRefreshResolve.current = () => finish(true);
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" || reg.waiting) finish(true);
        else if (installing.state === "redundant") finish(needRefreshRef.current);
      });
      setTimeout(() => finish(needRefreshRef.current), 10_000);
    });
  }, []);

  return { needRefresh, applyUpdate, dismiss, checkForUpdate, supported };
}
