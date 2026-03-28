import { describe, expect, test } from "bun:test";
import { resolveSpawnError, resolveSpawnReady, waitForSpawnAck } from "./runner-control";

const isCI = !!process.env.CI;

describe("runner spawn ack coordination", () => {
    test("resolves when ack arrives after waiter is registered", async () => {
        const sessionId = `s-${crypto.randomUUID()}`;
        const ackPromise = waitForSpawnAck(sessionId, 100);
        resolveSpawnReady(sessionId);

        await expect(ackPromise).resolves.toEqual({ ok: true });
    });

    test("resolves even when ack arrives before waiter registration (race)", async () => {
        const sessionId = `s-${crypto.randomUUID()}`;
        resolveSpawnReady(sessionId);

        await expect(waitForSpawnAck(sessionId, 25)).resolves.toEqual({ ok: true });
    });

    (isCI ? test.skip : test)("returns early error even when error arrives before waiter registration", async () => {
        const sessionId = `s-${crypto.randomUUID()}`;
        resolveSpawnError(sessionId, "Runner spawn failed");

        await expect(waitForSpawnAck(sessionId, 25)).resolves.toEqual({
            ok: false,
            message: "Runner spawn failed",
        });
    });
});
