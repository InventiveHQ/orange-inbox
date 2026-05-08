"use client";

import { useEffect, useState } from "react";

interface StorageStats {
  total_used: number;
  total_soft: number;
  total_hard: number;
  any_warning: boolean;
  any_soft_full: boolean;
  any_hard_full: boolean;
  dbs: {
    id: string;
    display_name: string | null;
    binding_name: string;
    byte_estimate: number;
    soft_max_bytes: number | null;
    hard_max_bytes: number | null;
    active: number;
    state: "ok" | "warning" | "soft_full" | "hard_full";
  }[];
}

// Sidebar bottom-left capacity indicator. Polls /api/storage on mount and
// every 60s while mounted (cheap query — single SELECT against mail_dbs).
// Three visual states:
//   ok        — neutral bar, percentage label, no extra prose
//   warning   — amber bar, "Storage filling up — consider expanding"
//   soft/hard — red bar, "Storage <state> — provision an overflow DB"
export default function CapacityIndicator({ collapsed }: { collapsed?: boolean }) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/storage");
        if (!res.ok) return;
        const j = (await res.json()) as StorageStats;
        if (!cancelled) setStats(j);
      } catch {
        // network hiccup — leave the previous value alone
      }
    }
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!stats) return null;
  const pct = stats.total_soft > 0 ? Math.min(100, (stats.total_used / stats.total_soft) * 100) : 0;
  const overall: "ok" | "warning" | "soft_full" | "hard_full" = stats.any_hard_full
    ? "hard_full"
    : stats.any_soft_full
      ? "soft_full"
      : stats.any_warning
        ? "warning"
        : "ok";

  if (collapsed) {
    // Compressed dot in the bottom-left when sidebar is collapsed: just the
    // colored circle. Tooltip carries the percentage.
    return (
      <div
        className="flex items-center justify-center py-2"
        title={`${formatBytes(stats.total_used)} / ${formatBytes(stats.total_soft)} (${pct.toFixed(0)}%)`}
      >
        <span className={`inline-block w-3 h-3 rounded-full ${dotColor(overall)}`} />
      </div>
    );
  }

  return (
    <div className="px-2 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="block w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-center justify-between gap-2 mb-1 text-neutral-500">
          <span>Storage</span>
          <span className="tabular-nums">{pct.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
          <div
            className={`h-full transition-[width] duration-300 ${barColor(overall)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 text-[10px] text-neutral-500 tabular-nums">
          {formatBytes(stats.total_used)} of {formatBytes(stats.total_soft)}
        </div>
      </button>

      {overall !== "ok" && (
        <p
          className={`mt-1 text-[10px] leading-snug ${
            overall === "warning" ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-400"
          }`}
        >
          {overall === "warning" && "Filling up — consider running scripts/provision-overflow.sh"}
          {overall === "soft_full" && "At soft cap — new mail still works on existing threads, but provision overflow soon"}
          {overall === "hard_full" && "Hard cap hit — provision overflow now or new mail will be rejected"}
        </p>
      )}

      {open && (
        <ul className="mt-2 space-y-1 border-t border-neutral-200 dark:border-neutral-800 pt-2">
          {stats.dbs.map(d => {
            const dPct =
              d.soft_max_bytes && d.soft_max_bytes > 0
                ? Math.min(100, (d.byte_estimate / d.soft_max_bytes) * 100)
                : 0;
            return (
              <li key={d.id} className="text-[10px]">
                <div className="flex items-center justify-between text-neutral-700 dark:text-neutral-300">
                  <span className="truncate">
                    {d.display_name ?? d.id}
                    {d.active === 0 && (
                      <span className="ml-1 text-neutral-500 uppercase tracking-wider">
                        sealed
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">{dPct.toFixed(0)}%</span>
                </div>
                <div className="h-1 rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden mt-0.5">
                  <div
                    className={`h-full ${barColor(d.state)}`}
                    style={{ width: `${dPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function barColor(state: "ok" | "warning" | "soft_full" | "hard_full"): string {
  if (state === "hard_full") return "bg-red-600";
  if (state === "soft_full") return "bg-red-500";
  if (state === "warning") return "bg-amber-500";
  return "bg-neutral-500 dark:bg-neutral-400";
}

function dotColor(state: "ok" | "warning" | "soft_full" | "hard_full"): string {
  if (state === "hard_full") return "bg-red-600";
  if (state === "soft_full") return "bg-red-500";
  if (state === "warning") return "bg-amber-500";
  return "bg-emerald-500";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
