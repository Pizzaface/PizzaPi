import * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";

// ── Shared types (mirrored from runner) ──────────────────────────────────────

export interface UsageWindow {
    label: string;
    utilization: number; // 0–100
    resets_at: string;   // ISO timestamp
}

export interface ProviderUsageData {
    windows: UsageWindow[];
}

// Record<providerId, ProviderUsageData>  e.g. { anthropic: {...}, "openai-codex": {...} }
export type ProviderUsageMap = Record<string, ProviderUsageData>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function usageColor(pct: number) {
    if (pct >= 90) return "bg-red-500 dark:bg-red-400";
    if (pct >= 70) return "bg-amber-400 dark:bg-amber-300";
    return "bg-green-500 dark:bg-green-400";
}

function formatReset(isoString: string) {
    return new Date(isoString).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

// ── Sub-components ───────────────────────────────────────────────────────────

function UsageBar({ window: w }: { window: UsageWindow }) {
    const pct = Math.min(100, Math.max(0, w.utilization));
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2 text-[0.65rem] text-muted-foreground">
                <span>{w.label}</span>
                <span className="font-medium tabular-nums">{pct.toFixed(0)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                <div
                    className={cn("h-full rounded-full transition-all", usageColor(pct))}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="text-[0.6rem] text-muted-foreground/60">resets {formatReset(w.resets_at)}</div>
        </div>
    );
}

function ProviderSection({ providerId, data }: { providerId: string; data: ProviderUsageData }) {
    if (data.windows.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
                <ProviderIcon provider={providerId} className="size-3 flex-shrink-0" />
                <span className="text-[0.7rem] font-semibold capitalize text-foreground">{providerId}</span>
            </div>
            {data.windows.map((w) => (
                <UsageBar key={w.label} window={w} />
            ))}
        </div>
    );
}

// ── Public component ─────────────────────────────────────────────────────────

export function UsageIndicator({ usage }: { usage: ProviderUsageMap | null }) {
    const entries = React.useMemo(
        () => Object.entries(usage ?? {}).filter(([, d]) => d.windows.length > 0),
        [usage],
    );

    if (entries.length === 0) return null;

    // Badge: show the first window of the first provider
    const [firstId, firstData] = entries[0];
    const primary = firstData.windows[0];
    const pct = Math.min(100, Math.max(0, primary.utilization));
    const dotColor =
        pct >= 90
            ? "bg-red-500 dark:bg-red-400 shadow-[0_0_4px_#ef444480] dark:shadow-[0_0_6px_#f8717180]"
            : pct >= 70
              ? "bg-amber-400 dark:bg-amber-300 shadow-[0_0_4px_#fbbf2480] dark:shadow-[0_0_6px_#fcd34d80]"
              : "bg-green-500 dark:bg-green-400 shadow-[0_0_4px_#22c55e80] dark:shadow-[0_0_6px_#4ade8080]";

    return (
        <TooltipProvider delayDuration={200}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-default select-none"
                        aria-label="Provider subscription usage"
                        type="button"
                    >
                        <ProviderIcon provider={firstId} className={cn("size-3 flex-shrink-0 hidden sm:block")} />
                        <span className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", dotColor)} />
                        <span className="hidden sm:inline tabular-nums">{pct.toFixed(0)}%</span>
                    </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="w-56 p-3 space-y-4 bg-popover text-popover-foreground border border-border">
                    <p className="text-xs font-semibold text-foreground">Subscription usage</p>
                    {entries.map(([id, data]) => (
                        <ProviderSection key={id} providerId={id} data={data} />
                    ))}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
