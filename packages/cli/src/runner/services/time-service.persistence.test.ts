/**
 * Regression tests for durable timer/cron state:
 *   - one-shot timers keep their absolute deadline across a daemon restart
 *     (rebuilding as now+duration would drift the deadline forever)
 *   - a changed duration param invalidates the persisted deadline
 *   - state file writes are atomic (temp+rename, no partial file left behind)
 *   - corrupt state JSON is quarantined instead of silently reset
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimeService } from "./time-service.js";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";

const originalHome = process.env.HOME;
let service: TimeService | undefined;

afterEach(() => {
    service?.dispose();
    service = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
});

function setupHome(): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-time-persist-"));
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    process.env.HOME = home;
    return home;
}

const statePath = (home: string) => join(home, ".pizzapi", "time-service-state.json");

function timerSub(duration: string, subscriptionId = "sub-1"): TriggerSubscriptionEntry {
    return {
        sessionId: "sess-1",
        triggerType: "time:timer_fired",
        subscriptionId,
        runnerId: "runner-test",
        params: { duration },
    };
}

describe("TimeService durable timer state", () => {
    test("persists absolute fireAt and reuses it after a restart", () => {
        const home = setupHome();
        service = new TimeService();
        const before = Date.now();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });

        const persisted = JSON.parse(readFileSync(statePath(home), "utf-8"));
        const entry = persisted["timer:sub-1"];
        expect(entry.duration).toBe("1h");
        expect(entry.nextFireAt).toBeGreaterThanOrEqual(before + 3_600_000);
        service.dispose();

        // Simulate a daemon restart 100ms "later" by shrinking the persisted
        // deadline; a drifting rebuild (now+1h) would overwrite it.
        const shifted = entry.nextFireAt - 1000;
        writeFileSync(statePath(home), JSON.stringify({ "timer:sub-1": { ...entry, nextFireAt: shifted } }), "utf-8");

        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });
        const after = JSON.parse(readFileSync(statePath(home), "utf-8"));
        expect(after["timer:sub-1"].nextFireAt).toBe(shifted);
    });

    test("changed duration param recomputes and re-persists the deadline", () => {
        const home = setupHome();
        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });
        const first = JSON.parse(readFileSync(statePath(home), "utf-8"))["timer:sub-1"];

        service.reconcileSubscriptions([timerSub("2h")], { mode: "snapshot" });
        const second = JSON.parse(readFileSync(statePath(home), "utf-8"))["timer:sub-1"];
        expect(second.duration).toBe("2h");
        expect(second.nextFireAt).toBeGreaterThan(first.nextFireAt);
    });

    test("unsubscribe and stale-snapshot removal drop persisted timer state", () => {
        const home = setupHome();
        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });
        expect(JSON.parse(readFileSync(statePath(home), "utf-8"))["timer:sub-1"]).toBeDefined();

        // Empty snapshot removes the in-memory timer AND its persisted state.
        service.reconcileSubscriptions([], { mode: "snapshot" });
        expect(JSON.parse(readFileSync(statePath(home), "utf-8"))["timer:sub-1"]).toBeUndefined();
    });

    test("snapshot prunes persisted state for subscriptions gone while the daemon was down", () => {
        const home = setupHome();
        writeFileSync(
            statePath(home),
            JSON.stringify({
                "timer:dead-sub": { nextFireAt: Date.now() + 60_000, iteration: 0, duration: "1m" },
                "dead-cron": { nextFireAt: Date.now() + 60_000, iteration: 3 },
            }),
            "utf-8",
        );
        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });
        const state = JSON.parse(readFileSync(statePath(home), "utf-8"));
        expect(state["timer:dead-sub"]).toBeUndefined();
        expect(state["dead-cron"]).toBeUndefined();
        expect(state["timer:sub-1"]).toBeDefined();
    });

    test("corrupt state file is quarantined, not silently reset", () => {
        const home = setupHome();
        writeFileSync(statePath(home), "{not json!", "utf-8");
        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });

        const files = readdirSync(join(home, ".pizzapi"));
        expect(files.some((f) => f.startsWith("time-service-state.json.corrupt-"))).toBe(true);
        // Fresh state written cleanly afterwards.
        expect(JSON.parse(readFileSync(statePath(home), "utf-8"))["timer:sub-1"]).toBeDefined();
    });

    test("state writes leave no temp file behind (atomic rename)", () => {
        const home = setupHome();
        service = new TimeService();
        service.reconcileSubscriptions([timerSub("1h")], { mode: "snapshot" });
        const files = readdirSync(join(home, ".pizzapi"));
        expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    });
});
