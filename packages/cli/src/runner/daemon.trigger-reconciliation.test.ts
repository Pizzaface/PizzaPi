import { describe, expect, test } from "bun:test";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { reconcileSnapshotSubscriptions } from "./daemon.js";
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
