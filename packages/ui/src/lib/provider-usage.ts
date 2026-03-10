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

export function providerUsageDisplay(data: ProviderUsageData) {
  if (data.status === "unknown") {
    return { kind: "unknown" as const, usedPct: null, remainingPct: null };
  }

  const usedPct = Math.min(100, Math.max(0, ...data.windows.map((w) => w.utilization)));
  return {
    kind: "usage" as const,
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
  };
}
