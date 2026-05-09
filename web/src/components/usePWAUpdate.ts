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
//     an update — we send SKIP_WAITING and either auto-reload (if we're
//     within the first 5 s of page load — silent update on cold start) or
//     surface needRefresh so the UI can show a toast.
//   • checkForUpdate() forces reg.update() and resolves true if a new SW
//     is now waiting (10 s cap).
//   • applyUpdate() posts SKIP_WAITING and reloads.

const PAGE_LOAD_AUTO_APPLY_MS = 5_000;

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
  const supported =
    typeof window !== "undefined" && "serviceWorker" in navigator;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;

    const trackInstalling = (reg: ServiceWorkerRegistration, sw: ServiceWorker) => {
      sw.addEventListener("statechange", () => {
        if (cancelled) return;
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          handleWaiting(reg);
        }
      });
    };

    const handleWaiting = (reg: ServiceWorkerRegistration) => {
      if (performance.now() < PAGE_LOAD_AUTO_APPLY_MS) {
        try {
          sessionStorage.setItem("orange_pre_update_path", window.location.pathname + window.location.search);
        } catch {}
        reg.waiting?.postMessage({ type: "SKIP_WAITING" });
        // controllerchange below triggers the reload.
        return;
      }
      needRefreshRef.current = true;
      setNeedRefresh(true);
      onNeedRefreshResolve.current?.();
      onNeedRefreshResolve.current = null;
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (cancelled) return;
        if (reg.waiting && navigator.serviceWorker.controller) handleWaiting(reg);
        if (reg.installing) trackInstalling(reg, reg.installing);
        reg.addEventListener("updatefound", () => {
          if (reg.installing) trackInstalling(reg, reg.installing);
        });
      })
      .catch((e) => console.warn("sw registration failed", e));

    let reloading = false;
    const onCtrlChange = () => {
      if (reloading) return;
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
