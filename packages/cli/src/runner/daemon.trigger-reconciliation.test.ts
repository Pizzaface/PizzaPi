import { describe, expect, test } from "bun:test";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { applyTriggerSubscriptionDeltaToCache, reconcileSnapshotSubscriptions, replayNewerTriggerDeltas } from "./daemon.js";
import { ServiceRegistry, type ServiceHandler, type ServiceInitOptions, type ReconcileOptions } from "./service-handler.js";
import type { Socket } from "socket.io-client";

class ReconcilingService implements ServiceHandler {
    readonly calls: TriggerSubscriptionEntry[][] = [];

    constructor(readonly id: string) {}

    init(_socket: Socket, _options: ServiceInitOptions): void {}
    dispose(): void {}

    reconcileSubscriptions(subscriptions: TriggerSubscriptionEntry[], _options?: ReconcileOptions): { applied: number; errors?: string[] } {
        this.calls.push(subscriptions);
        return { applied: subscriptions.length };
    }
}

class PassiveService implements ServiceHandler {
    constructor(readonly id: string) {}

    init(_socket: Socket, _options: ServiceInitOptions): void {}
    dispose(): void {}
}

function entry(sessionId: string, triggerType: string, subscriptionId?: string): TriggerSubscriptionEntry {
    return {
        sessionId,
        triggerType,
        subscriptionId: subscriptionId ?? `${sessionId}-${triggerType}`,
        runnerId: "runner-test",
        params: {},
    };
}

describe("applyTriggerSubscriptionDeltaToCache", () => {
    test("replaces one subscription by subscriptionId", () => {
        const first = entry("session-1", "time:timer_fired", "sub-1");
        const second = entry("session-1", "time:timer_fired", "sub-2");
        const updated = { ...first, params: { duration: "5m" } };

        expect(applyTriggerSubscriptionDeltaToCache([first, second], "update", updated)).toEqual([second, updated]);
    });

    test("legacy unsubscribe removes all matching session/type subscriptions", () => {
        const first = entry("session-1", "time:timer_fired", "sub-1");
        const second = entry("session-1", "time:timer_fired", "sub-2");
        const other = entry("session-2", "time:timer_fired", "sub-3");

        expect(applyTriggerSubscriptionDeltaToCache([first, second, other], "unsubscribe", {
            ...first,
            subscriptionId: "legacy:all:time:timer_fired",
        })).toEqual([other]);
    });
});

describe("replayNewerTriggerDeltas — snapshot/delta race", () => {
    // Regression: the server reserves snapshotRevision BEFORE the async
    // subscription read, so a delta at revision N+1 can be applied by the
    // daemon and then overwritten by a snapshot at revision N that predates
    // it. Replaying buffered deltas with revision > snapshot revision must
    // restore the newer state.
    test("a subscribe delta newer than the snapshot survives snapshot install", () => {
        const preexisting = entry("session-1", "time:cron", "sub-old");
        const newSub = entry("session-2", "github:pr_comment", "sub-new");
        // Snapshot at revision 10 was read before sub-new was stored.
        const result = replayNewerTriggerDeltas([preexisting], 10, [
            { revision: 11, action: "subscribe", subscription: newSub },
        ]);
        expect(result).toEqual([preexisting, newSub]);
    });

    test("an unsubscribe delta newer than the snapshot survives snapshot install", () => {
        const kept = entry("session-1", "time:cron", "sub-kept");
        const removed = entry("session-1", "time:at", "sub-removed");
        // Snapshot (rev 10) still contains sub-removed because the store read
        // happened before the unsubscribe (rev 12) landed.
        const result = replayNewerTriggerDeltas([kept, removed], 10, [
            { revision: 12, action: "unsubscribe", subscription: removed },
        ]);
        expect(result).toEqual([kept]);
    });

    test("deltas at or below the snapshot revision are NOT replayed", () => {
        const current = entry("session-1", "time:cron", "sub-1");
        const stale = entry("session-1", "time:cron", "sub-1");
        // A delta already reflected in the snapshot (revision ≤ snapshot) must
        // not be re-applied — e.g. an old unsubscribe would wrongly delete a
        // re-created subscription the snapshot carries.
        const result = replayNewerTriggerDeltas([current], 10, [
            { revision: 9, action: "unsubscribe", subscription: stale },
            { revision: 10, action: "unsubscribe", subscription: stale },
        ]);
        expect(result).toEqual([current]);
    });

    test("multiple newer deltas replay in order on top of the baseline", () => {
        const base = entry("session-1", "time:cron", "sub-a");
        const added = entry("session-2", "svc:event", "sub-b");
        const updated = { ...added, params: { x: "1" } };
        const result = replayNewerTriggerDeltas([base], 5, [
            { revision: 6, action: "subscribe", subscription: added },
            { revision: 7, action: "update", subscription: updated },
            { revision: 8, action: "unsubscribe", subscription: base },
        ]);
        expect(result).toEqual([updated]);
    });
});

describe("reconcileSnapshotSubscriptions", () => {
    test("reconciles loaded services with an empty snapshot subset when absent", () => {
        const registry = new ServiceRegistry();
        const timeService = new ReconcilingService("time");
        const gitService = new ReconcilingService("git");
        registry.register(timeService);
        registry.register(gitService);

        const snapshot = [entry("session-1", "git:status_changed")];
        const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };

        const result = reconcileSnapshotSubscriptions(registry, snapshot, {
            info: (message) => logs.info.push(message),
            warn: (message) => logs.warn.push(message),
            error: (message) => logs.error.push(message),
        });

        expect(gitService.calls).toEqual([[snapshot[0]]]);
        expect(timeService.calls).toEqual([[]]);
        expect(result).toEqual({ applied: 1, errors: [] });
        expect(logs).toEqual({ info: [], warn: [], error: [] });
    });

    test("preserves multiple same-session same-type subscriptions as distinct entries", () => {
        const registry = new ServiceRegistry();
        const timeService = new ReconcilingService("time");
        registry.register(timeService);

        const snapshot = [
            entry("session-1", "time:timer_fired", "sub-1"),
            entry("session-1", "time:timer_fired", "sub-2"),
        ];

        const result = reconcileSnapshotSubscriptions(registry, snapshot);

        expect(timeService.calls).toHaveLength(1);
        expect(timeService.calls[0]).toHaveLength(2);
        expect(timeService.calls[0]?.map((sub) => sub.subscriptionId)).toEqual(["sub-1", "sub-2"]);
        expect(result).toEqual({ applied: 2, errors: [] });
    });

    test("warns for unknown prefixes and still reconciles known services", () => {
        const registry = new ServiceRegistry();
        const timeService = new ReconcilingService("time");
        registry.register(timeService);
        registry.register(new PassiveService("terminal"));

        const snapshot = [
            entry("session-1", "ghost:event"),
            entry("session-2", "terminal:finished"),
        ];
        const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };

        const result = reconcileSnapshotSubscriptions(registry, snapshot, {
            info: (message) => logs.info.push(message),
            warn: (message) => logs.warn.push(message),
            error: (message) => logs.error.push(message),
        });

        expect(timeService.calls).toEqual([[]]);
        expect(result).toEqual({ applied: 0, errors: [] });
        expect(logs.warn).toEqual([
            '[trigger-reconciliation] no service found for prefix "ghost" (1 subscriptions)',
        ]);
        expect(logs.info).toEqual([
            '[trigger-reconciliation] service "terminal" does not implement reconcileSubscriptions, skipping 1 subscriptions',
        ]);
        expect(logs.error).toEqual([]);
    });
});
