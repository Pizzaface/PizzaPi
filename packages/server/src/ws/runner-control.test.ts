import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadRunnerControl() {
    mock.restore();
    const mod = await import(`./runner-control.ts?runner-control-test=${crypto.randomUUID()}`);
    mod._resetRunnerControlForTesting();
    return mod;
}

afterEach(() => {
    mock.restore();
});

describe("runner spawn ack coordination", () => {
    test("resolves when ack arrives after waiter is registered", async () => {
        const { waitForSpawnAck, resolveSpawnReady } = await loadRunnerControl();
        const ackPromise = waitForSpawnAck("runner-control-after-wait", 100);
        resolveSpawnReady("runner-control-after-wait");

        await expect(ackPromise).resolves.toEqual({ ok: true });
    });

    test("resolves even when ack arrives before waiter registration (race)", async () => {
        const { waitForSpawnAck, resolveSpawnReady } = await loadRunnerControl();
        resolveSpawnReady("runner-control-ready-early");

        await expect(waitForSpawnAck("runner-control-ready-early", 25)).resolves.toEqual({ ok: true });
    });

    test("returns early error even when error arrives before waiter registration", async () => {
        const { waitForSpawnAck, resolveSpawnError } = await loadRunnerControl();
        resolveSpawnError("runner-control-error-early", "Runner spawn failed");

        await expect(waitForSpawnAck("runner-control-error-early", 25)).resolves.toEqual({
            ok: false,
            message: "Runner spawn failed",
        });
    });
});

describe("pending child spawn binding (review R2 security fix)", () => {
    test("records and retrieves the (runnerId, parentSessionId) binding for a spawn request", async () => {
        const { recordPendingChildSpawn, getPendingChildSpawn } = await loadRunnerControl();
        recordPendingChildSpawn("child-1", { runnerId: "runner-a", parentSessionId: "parent-1", userId: "user-a" });

        expect(getPendingChildSpawn("child-1")).toEqual({ runnerId: "runner-a", parentSessionId: "parent-1", userId: "user-a" });
    });

    test("records a null parentSessionId when no parent was requested", async () => {
        const { recordPendingChildSpawn, getPendingChildSpawn } = await loadRunnerControl();
        recordPendingChildSpawn("child-2", { runnerId: "runner-a" });

        expect(getPendingChildSpawn("child-2")).toEqual({ runnerId: "runner-a", parentSessionId: null, userId: undefined });
    });

    test("returns undefined for a sessionId with no recorded pending spawn", async () => {
        const { getPendingChildSpawn } = await loadRunnerControl();
        expect(getPendingChildSpawn("never-requested")).toBeUndefined();
    });

    test("a later record for the same sessionId replaces the earlier one", async () => {
        const { recordPendingChildSpawn, getPendingChildSpawn } = await loadRunnerControl();
        recordPendingChildSpawn("child-3", { runnerId: "runner-a", parentSessionId: "parent-1" });
        recordPendingChildSpawn("child-3", { runnerId: "runner-b", parentSessionId: "parent-2" });

        expect(getPendingChildSpawn("child-3")).toEqual({ runnerId: "runner-b", parentSessionId: "parent-2", userId: undefined });
    });
});
