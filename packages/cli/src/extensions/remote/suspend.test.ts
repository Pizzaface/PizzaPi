import { afterEach, describe, expect, test } from "bun:test";
import { getSuspendIdleMs, shouldSuspend, type SuspendProbe } from "./suspend.js";

const idle: SuspendProbe = {
    sessionCompleteDelivered: true,
    hasPendingMessages: false,
    isAgentBusy: false,
    activeSubagents: false,
    runningBackgroundJobs: 0,
    activeSubscriptionCount: 0,
    linkedChildCount: 0,
};

describe("shouldSuspend", () => {
    test("suspends a fully idle child whose completion reached the parent", () => {
        expect(shouldSuspend(idle)).toBe(true);
    });

    test.each([
        ["completion not delivered", { sessionCompleteDelivered: false }],
        ["pending messages", { hasPendingMessages: true }],
        ["agent busy", { isAgentBusy: true }],
        ["active subagents", { activeSubagents: true }],
        ["running background jobs", { runningBackgroundJobs: 1 }],
        ["active subscriptions", { activeSubscriptionCount: 2 }],
        ["linked children", { linkedChildCount: 1 }],
        ["subscription probe failed", { activeSubscriptionCount: null }],
        ["child-count probe failed", { linkedChildCount: null }],
    ] as const)("stays alive with %s", (_label, override) => {
        expect(shouldSuspend({ ...idle, ...override })).toBe(false);
    });
});

describe("getSuspendIdleMs", () => {
    afterEach(() => {
        delete process.env.PIZZAPI_SUSPEND_IDLE_MS;
    });

    test("defaults to 30 minutes when unset", () => {
        expect(getSuspendIdleMs()).toBe(30 * 60_000);
    });

    test("honors a valid override above the floor", () => {
        process.env.PIZZAPI_SUSPEND_IDLE_MS = "60000";
        expect(getSuspendIdleMs()).toBe(60_000);
    });

    test("clamps an override below the 5s floor", () => {
        process.env.PIZZAPI_SUSPEND_IDLE_MS = "100";
        expect(getSuspendIdleMs()).toBe(5_000);
    });

    test.each([
        ["empty string", ""],
        ["non-numeric", "soon"],
        ["zero", "0"],
        ["negative", "-5000"],
    ] as const)("ignores an invalid value (%s) and falls back to the default", (_label, value) => {
        process.env.PIZZAPI_SUSPEND_IDLE_MS = value;
        expect(getSuspendIdleMs()).toBe(30 * 60_000);
    });
});
