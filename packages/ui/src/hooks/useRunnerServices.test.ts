/**
 * Tests for useRunnerServices — specifically verifying that service state
 * is properly cleared when switching from a runner session to a non-runner
 * (local) session.
 *
 * Bug: the `else` branch in the effect only set state when the socket cache
 * had data (`if (cached.size > 0)`), so switching to a non-runner session
 * left stale services/panels from the previous runner session visible.
 */
import { describe, expect, test, mock } from "bun:test";

const actualViewerSwitchModule = await import("../lib/viewer-switch");
mock.module("@/lib/viewer-switch", () => actualViewerSwitchModule);

const { attachServiceAnnounceListener, seedServiceCache } = await import("./useRunnerServices");

// The internal cache keys used by the module
const SERVICE_IDS_KEY = "__serviceIds";
const PANELS_KEY = "__panels";
const TRIGGER_DEFS_KEY = "__triggerDefs";
const SIGIL_DEFS_KEY = "__sigilDefs";

// Minimal mock socket with on/off/emit — uses a plain object with
// index-writable properties so `(socket as any)[KEY] = value` works.
function createMockSocket(): any {
    const listeners = new Map<string, Set<Function>>();
    const socket: Record<string, any> = {
        on(event: string, fn: Function) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off(event: string, fn: Function) {
            listeners.get(event)?.delete(fn);
        },
        emit(event: string, ...args: any[]) {
            for (const fn of listeners.get(event) ?? []) fn(...args);
        },
    };
    return socket;
}

describe("attachServiceAnnounceListener", () => {
    test("populates socket cache on service_announce", () => {
        const socket = createMockSocket();
        attachServiceAnnounceListener(socket);

        socket.emit("service_announce", {
            serviceIds: ["github", "godmother"],
            panels: [{ serviceId: "github", port: 3001, label: "GitHub", icon: "git-branch" }],
            triggerDefs: [{ type: "github:pr_comment", label: "PR Comment" }],
            sigilDefs: [{ type: "pr", label: "Pull Request", serviceId: "github" }],
        });

        expect(socket[SERVICE_IDS_KEY]).toEqual(["github", "godmother"]);
        expect(socket[PANELS_KEY]).toHaveLength(1);
        expect(socket[TRIGGER_DEFS_KEY]).toHaveLength(1);
        expect(socket[SIGIL_DEFS_KEY]).toHaveLength(1);
    });

    test("clears socket cache on disconnect", () => {
        const socket = createMockSocket();
        attachServiceAnnounceListener(socket);

        socket.emit("service_announce", {
            serviceIds: ["github"],
            panels: [],
            triggerDefs: [],
            sigilDefs: [],
        });
        expect(socket[SERVICE_IDS_KEY]).toEqual(["github"]);

        socket.emit("disconnect");

        expect(socket[SERVICE_IDS_KEY]).toBeUndefined();
        expect(socket[PANELS_KEY]).toBeUndefined();
        expect(socket[TRIGGER_DEFS_KEY]).toBeUndefined();
        expect(socket[SIGIL_DEFS_KEY]).toBeUndefined();
    });
});

describe("seedServiceCache", () => {
    test("copies service data from previous socket to new socket", () => {
        const prev = createMockSocket();
        attachServiceAnnounceListener(prev);
        prev.emit("service_announce", {
            serviceIds: ["github"],
            panels: [{ serviceId: "github", port: 3001, label: "GitHub", icon: "git-branch" }],
            triggerDefs: [{ type: "github:pr_comment", label: "PR Comment" }],
            sigilDefs: [{ type: "pr", label: "Pull Request", serviceId: "github" }],
        });

        const next = createMockSocket();
        seedServiceCache(next, prev);

        expect(next[SERVICE_IDS_KEY]).toEqual(["github"]);
        expect(next[PANELS_KEY]).toHaveLength(1);
        expect(next[TRIGGER_DEFS_KEY]).toHaveLength(1);
        expect(next[SIGIL_DEFS_KEY]).toHaveLength(1);
    });

    test("does not copy when prevSocket is null", () => {
        const next = createMockSocket();
        seedServiceCache(next, null);

        expect(next[SERVICE_IDS_KEY]).toBeUndefined();
        expect(next[PANELS_KEY]).toBeUndefined();
    });

    test("new socket for non-runner session has no cached data (no seedServiceCache called)", () => {
        // This verifies the precondition: a fresh socket without seeding
        // has empty caches. Combined with the fix (unconditional state setting),
        // this means switching to a non-runner session will clear stale state.
        const socket = createMockSocket();
        attachServiceAnnounceListener(socket);

        // No service_announce emitted → cache stays empty
        expect(socket[SERVICE_IDS_KEY]).toBeUndefined();
        expect(socket[PANELS_KEY]).toBeUndefined();
        expect(socket[TRIGGER_DEFS_KEY]).toBeUndefined();
        expect(socket[SIGIL_DEFS_KEY]).toBeUndefined();
    });
});
