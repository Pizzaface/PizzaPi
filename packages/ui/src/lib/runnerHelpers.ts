import type { RunnerInfo } from "@pizzapi/protocol";

/**
 * Pure helper: insert or replace a runner in the list by runnerId.
 * Used by runner_added events (always upserts, even if not previously seen).
 *
 * Extracted from useRunnersFeed so it can be unit-tested without
 * pulling in React/socket.io dependencies.
 */
export function upsert(list: RunnerInfo[], incoming: RunnerInfo): RunnerInfo[] {
    const idx = list.findIndex(r => r.runnerId === incoming.runnerId);
    if (idx === -1) return [...list, incoming];
    const next = [...list];
    next[idx] = incoming;
    return next;
}
