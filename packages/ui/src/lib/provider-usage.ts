export interface UsageWindow {
  label: string;
  utilization: number; // 0–100
  resets_at: string;   // ISO timestamp
}

export interface ProviderUsageData {
  windows: UsageWindow[];
  status?: "ok" | "unknown";
  errorCode?: number;
}

// Record<providerId, ProviderUsageData>  e.g. { anthropic: {...}, "openai-codex": {...} }
export type ProviderUsageMap = Record<string, ProviderUsageData>;

export function showsUsageIndicator(providerId: string): boolean {
  return !providerId.toLowerCase().startsWith("google");
}

/**
 * A window whose `resets_at` has passed has already rolled over, so its cached
 * utilization is stale (the daemon caches Anthropic for 15 min and the UI only
 * updates on heartbeats). Treat it as reset rather than reporting an old number.
 *
 * An unparseable `resets_at` fails open — better to show a number we can't date
 * than to silently drop a window.
 */
export function isWindowExpired(w: UsageWindow, now = Date.now()): boolean {
  const resetsAt = Date.parse(w.resets_at);
  return Number.isFinite(resetsAt) && resetsAt <= now;
}

/** Windows that are still in effect. */
export function activeWindows(windows: UsageWindow[], now = Date.now()): UsageWindow[] {
  return windows.filter((w) => !isWindowExpired(w, now));
}

export function providerUsageDisplay(data: ProviderUsageData, now = Date.now()) {
  if (data.status === "unknown") {
    return { kind: "unknown" as const, usedPct: null, remainingPct: null, label: null };
  }

  // The badge shows a single number, so it reports the most-constrained window.
  // Return its label too — otherwise "43%" reads as the whole subscription when
  // it's really just, say, the 5-hour window.
  let governing: UsageWindow | null = null;
  for (const w of activeWindows(data.windows, now)) {
    if (governing === null || w.utilization > governing.utilization) governing = w;
  }

  const usedPct = Math.min(100, Math.max(0, governing?.utilization ?? 0));
  return {
    kind: "usage" as const,
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    label: governing?.label ?? null,
  };
}
