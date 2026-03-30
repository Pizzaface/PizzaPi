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
