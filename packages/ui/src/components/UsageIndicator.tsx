import * as React from "react";
import { RefreshCw } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";
import {
    providerUsageDisplay,
    type UsageWindow,
    type ProviderUsageData,
    type ProviderUsageMap,
} from "@/lib/provider-usage";

export { providerUsageDisplay, type UsageWindow, type ProviderUsageData, type ProviderUsageMap };

// Auth source types relayed from the CLI
export type AuthSource = "oauth" | "env" | "auth.json" | "unknown" | null;

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
    const displayName = getProviderDisplayName(providerId);
    if (data.status === "unknown") {
        return (
            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                    <ProviderIcon provider={providerId} className="size-3 flex-shrink-0" />
                    <span className="text-[0.7rem] font-semibold text-foreground">{displayName}</span>
                </div>
                <div className="text-[0.7rem] text-muted-foreground">
                    Usage status unknown{typeof data.errorCode === "number" ? ` (HTTP ${data.errorCode})` : ""}.
                </div>
            </div>
        );
    }

    if (data.windows.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
                <ProviderIcon provider={providerId} className="size-3 flex-shrink-0" />
                <span className="text-[0.7rem] font-semibold text-foreground">{displayName}</span>
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
    const display = providerUsageDisplay(data);
    const label = display.kind === "unknown"
        ? `${getProviderDisplayName(providerId)} subscription usage (unknown)`
        : `${getProviderDisplayName(providerId)} subscription usage (${display.remainingPct.toFixed(0)}% remaining)`;

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
                    <span className={cn(
                        "inline-block h-2 w-2 rounded-full flex-shrink-0",
                        display.kind === "unknown" ? "bg-slate-400 dark:bg-slate-500" : dotColorClass(display.usedPct),
                    )} />
                    <span className="tabular-nums">{display.kind === "unknown" ? "UNKNOWN" : `${display.remainingPct.toFixed(0)}%`}</span>
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

/**
 * Badge for env-var / auth.json users: looks like a ProviderBadge but
 * says "USAGE" instead of a percentage since there's no subscription quota.
 */
function ApiKeyUsageBadge({ provider }: { provider: string }) {
    return (
        <span
            className="flex items-center gap-1.5 text-[0.65rem] leading-none sm:text-xs text-muted-foreground cursor-default select-none"
            title={`${getProviderDisplayName(provider)} — using API key (usage-based billing)`}
        >
            <ProviderIcon provider={provider} className="size-3 flex-shrink-0" />
            <span className="font-medium">USAGE</span>
        </span>
    );
}

// ── Public component ─────────────────────────────────────────────────────────

export interface UsageIndicatorProps {
    usage: ProviderUsageMap | null;
    /** Auth source of the currently active model's provider */
    authSource?: string | null;
    /** Provider ID of the currently active model */
    activeProvider?: string | null;
    /** Optional manual refresh action */
    onRefresh?: () => void;
    refreshing?: boolean;
}

export function UsageIndicator({ usage, authSource: rawAuthSource, activeProvider, onRefresh, refreshing = false }: UsageIndicatorProps) {
    const entries = React.useMemo(
        () => Object.entries(usage ?? {}).filter(([, d]) => d.status === "unknown" || d.windows.length > 0),
        [usage],
    );

    // Normalize the auth source string to the typed union
    const authSource: AuthSource = (
        rawAuthSource === "oauth" || rawAuthSource === "env" || rawAuthSource === "auth.json" || rawAuthSource === "unknown"
    ) ? rawAuthSource : null;

    // env / auth.json → show "USAGE" badge (no subscription quota)
    // oauth → show if there's usage data, or an explicit unknown state.
    const showApiKeyBadge = !!activeProvider && (authSource === "env" || authSource === "auth.json");

    if (entries.length === 0 && !showApiKeyBadge && !onRefresh) return null;

    return (
        <div className="flex items-center gap-2">
            {showApiKeyBadge && activeProvider && (
                <ApiKeyUsageBadge provider={activeProvider} />
            )}
            {entries.map(([id, data]) => (
                <ProviderBadge key={id} providerId={id} data={data} />
            ))}
            {onRefresh && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[0.65rem] sm:text-xs"
                    onClick={onRefresh}
                    disabled={refreshing}
                    aria-label="Refresh usage"
                    title="Refresh usage"
                >
                    <RefreshCw className={cn("mr-1 h-3 w-3", refreshing && "animate-spin")} />
                    Refresh
                </Button>
            )}
        </div>
    );
}
