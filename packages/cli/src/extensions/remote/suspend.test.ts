import { describe, expect, test } from "bun:test";
import { shouldSuspend, type SuspendProbe } from "./suspend.js";

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
