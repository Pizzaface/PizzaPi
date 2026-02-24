import * as React from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
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

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    anthropic: "Anthropic",
    "openai-codex": "OpenAI Codex",
    openai: "OpenAI",
    google: "Google",
    "google-gemini-cli": "Gemini",
    "google-antigravity": "Gemini",
    "google-vertex": "Google Vertex",
    amazon: "Amazon Bedrock",
    bedrock: "Amazon Bedrock",
    github: "GitHub",
    nvidia: "NVIDIA",
};

function getProviderDisplayName(providerId: string): string {
    return PROVIDER_DISPLAY_NAMES[providerId.toLowerCase()] ?? providerId;
}

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
                <span className="text-[0.7rem] font-semibold text-foreground">{getProviderDisplayName(providerId)}</span>
            </div>
            {data.windows.map((w) => (
                <UsageBar key={w.label} window={w} />
            ))}
        </div>
    );
}

function dotColorClass(pct: number): string {
    if (pct >= 90) return "bg-red-500 dark:bg-red-400 shadow-[0_0_4px_#ef444480] dark:shadow-[0_0_6px_#f8717180]";
    if (pct >= 70) return "bg-amber-400 dark:bg-amber-300 shadow-[0_0_4px_#fbbf2480] dark:shadow-[0_0_6px_#fcd34d80]";
    return "bg-green-500 dark:bg-green-400 shadow-[0_0_4px_#22c55e80] dark:shadow-[0_0_6px_#4ade8080]";
}

function ProviderBadge({
    providerId,
    data,
}: {
    providerId: string;
    data: ProviderUsageData;
}) {
    const usedPct = Math.min(
        100,
        Math.max(0, ...data.windows.map((w) => w.utilization)),
    );
    const remainingPct = Math.max(0, 100 - usedPct);
    const label = `${getProviderDisplayName(providerId)} subscription usage (${remainingPct.toFixed(0)}% remaining)`;

    // hovered: controlled by HoverCard's internal hover logic via onOpenChange
    // locked: toggled on click; cleared when pointer leaves while not hovering
    const [hovered, setHovered] = React.useState(false);
    const [locked, setLocked] = React.useState(false);

    return (
        <HoverCard open={hovered || locked} onOpenChange={setHovered} openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
                <button
                    className="flex items-center gap-1.5 text-[0.65rem] leading-none sm:text-xs text-muted-foreground hover:text-foreground transition-colors cursor-default select-none"
                    aria-label={label}
                    type="button"
                    onClick={() => setLocked((l) => !l)}
                >
                    <ProviderIcon provider={providerId} className="size-3 flex-shrink-0" />
                    <span className={cn("inline-block h-2 w-2 rounded-full flex-shrink-0", dotColorClass(usedPct))} />
                    <span className="tabular-nums">{remainingPct.toFixed(0)}%</span>
                </button>
            </HoverCardTrigger>
            <HoverCardContent
                side="bottom"
                align="end"
                className="w-56 p-3 space-y-2 bg-popover text-popover-foreground border border-border"
                onPointerDownOutside={() => setLocked(false)}
            >
                <ProviderSection providerId={providerId} data={data} />
            </HoverCardContent>
        </HoverCard>
    );
}

// ── Public component ─────────────────────────────────────────────────────────

export function UsageIndicator({ usage }: { usage: ProviderUsageMap | null }) {
    const entries = React.useMemo(
        () => Object.entries(usage ?? {}).filter(([, d]) => d.windows.length > 0),
        [usage],
    );

    if (entries.length === 0) return null;

    return (
        <div className="flex items-center gap-3">
            {entries.map(([id, data]) => (
                <ProviderBadge key={id} providerId={id} data={data} />
            ))}
        </div>
    );
}
