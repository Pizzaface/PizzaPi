import type { RunnerInfo } from "@pizzapi/protocol";

/**
 * Runner-scope helpers for service panels pinned to a specific runner
 * ("traveling" panels). Same runner → same color everywhere (tab dot, panel
 * badge), different runners → visually distinct colors.
 */

/** Deterministic hue (0–359) for a runner id. */
export function runnerHue(runnerId: string): number {
    let hash = 0;
    for (let i = 0; i < runnerId.length; i++) {
        hash = (hash * 31 + runnerId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
}

/** Human label for a runner: its announced name, else a truncated id. */
export function runnerDisplayName(runnerId: string, runners: RunnerInfo[] | null | undefined): string {
    const runner = runners?.find((r) => r.runnerId === runnerId);
    if (runner?.name) return runner.name;
    return runnerId.length > 8 ? `${runnerId.slice(0, 8)}…` : runnerId;
}