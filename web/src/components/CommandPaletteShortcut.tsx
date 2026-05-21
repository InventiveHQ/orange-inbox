"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

// The palette and its data bundle are only needed once the user hits ⌘K —
// keep it out of the inbox's initial bundle and load the chunk on first
// open. Gating the render on `open` (below) is what actually defers it:
// next/dynamic only fetches the chunk when the component first renders.
const CommandPalette = dynamic(() => import("./CommandPalette"), { ssr: false });

// Mounts once per inbox layout. Owns:
//   - the global ⌘K / Ctrl+K listener that opens the palette;
//   - the open/close state for <CommandPalette />.
//
// We deliberately listen with capture=true so that ⌘K wins over any
// browser/OS default in the page (Safari uses ⌘K elsewhere, but inside the
// app ⌘K is ours). When the user is typing in another input — say, the
// composer — we still let ⌘K through, since the only thing the platform
// would otherwise do with it is e.g. focus the URL bar in some setups, and
// we want palette access from the composer too.
//
// The one exception: if the active element is the palette's *own* input,
// the palette handles its own keys (Esc/Up/Down/Enter) — opening again over
// the existing dialog is a no-op.

export default function CommandPaletteShortcut() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // ⌘K on macOS, Ctrl+K everywhere else. We accept either modifier on
      // both platforms — typing Ctrl+K on a Mac (e.g. external keyboard)
      // should still open the palette.
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // No-op if the user is also holding Shift / Alt — those are typically
      // bound to other shortcuts and we don't want to swallow them.
      if (e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(prev => !prev);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Only mount once opened — CommandPalette's data cache is module-level, so
  // it survives the unmount on close and a reopen still serves instantly.
  return open ? <CommandPalette open onClose={() => setOpen(false)} /> : null;
}
