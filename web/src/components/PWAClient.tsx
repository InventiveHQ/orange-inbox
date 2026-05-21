"use client";

import usePWAUpdate from "./usePWAUpdate";
import usePushResync from "./usePushResync";
import UpdateToast from "./UpdateToast";

// Mounted once at the root layout. Owns service-worker registration and
// the update toast. The Settings page reaches into the same SW lifecycle
// via its own usePWAUpdate hook — that's fine, both hooks talk to the same
// browser-singleton ServiceWorkerRegistration.
export default function PWAClient() {
  const { needRefresh, applyUpdate, dismiss } = usePWAUpdate();
  // Keep the server's push subscription fresh on every launch — see hook.
  usePushResync();
  return <UpdateToast visible={needRefresh} onApply={applyUpdate} onDismiss={dismiss} />;
}
