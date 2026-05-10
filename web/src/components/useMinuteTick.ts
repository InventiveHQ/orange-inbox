"use client";

import { useEffect, useState } from "react";

// Shared per-minute tick. RelativeTime mounts in many places (thread header,
// compose recipient chip, contact card) and we don't want N independent
// setInterval timers chewing battery — they'd drift apart and produce
// inconsistent "their time" readings within the same paint.
//
// Single module-level interval, ref-counted by subscriber. The first
// component to mount starts the timer; the last to unmount stops it.
//
// Tick value is the current epoch *minute* (Date.now() / 60000 floored).
// Components can use it as a stable dependency in useMemo/useEffect — the
// number only changes once per wall-clock minute boundary, not on every
// render.

type Listener = (tickMinute: number) => void;

let timer: ReturnType<typeof setInterval> | null = null;
let nextRollover: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function emit() {
  const m = currentMinute();
  for (const l of listeners) l(m);
}

function start() {
  if (timer || nextRollover) return;
  // Align the first tick to the next wall-clock minute boundary so all
  // listeners see "their time" updates exactly when the displayed minute
  // would change. After that we settle into a plain 60s interval — drift
  // up to a second per minute is invisible at minute resolution.
  const msUntilBoundary = 60_000 - (Date.now() % 60_000);
  nextRollover = setTimeout(() => {
    emit();
    nextRollover = null;
    timer = setInterval(emit, 60_000);
  }, msUntilBoundary);
}

function stop() {
  if (nextRollover) {
    clearTimeout(nextRollover);
    nextRollover = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function useMinuteTick(): number {
  const [tick, setTick] = useState(currentMinute);
  useEffect(() => {
    const listener: Listener = m => setTick(m);
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }, []);
  return tick;
}
