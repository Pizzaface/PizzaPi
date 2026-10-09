import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    runnerSecrets,
    validateAndPersistRunnerSecret,
    getRunnerSecret,
    _resetRunnerSecretsForTesting,
    _claimChainsForTesting,
    initSioRegistry,
    localRunnerSockets,
    runnerRoom,
    serviceFollowRoom,
    emitToRunner,
} from "./context";
import {
    _injectRedisForTesting,
    _resetRedisKvStoreForTesting,
} from "../../redis-kv-store";

describe("service follow rooms", () => {
    test("is scoped by service and runner", () => {
        expect(serviceFollowRoom("tunnel", "runner/one")).toBe("svc-follow:tunnel:runner/one");
        expect(serviceFollowRoom("tunnel", "runner/two")).not.toBe(serviceFollowRoom("tunnel", "runner/one"));
    });
});


const store = new Map<string, string>();
let failNextGet = false;

const mockRedisClient = {
    isOpen: true,

    get: mock((key: string) => {
        if (failNextGet) {
            failNextGet = false;
            return Promise.reject(new Error("simulated Redis GET failure"));
        }
        return Promise.resolve(store.get(key) ?? null);
    }),

    set: mock((key: string, value: string, opts?: { NX?: boolean }) => {
        // Honor NX like real Redis so tests can exercise the atomic-claim path.
        if (opts?.NX && store.has(key)) {
            return Promise.resolve(null);
        }
        store.set(key, value);
        return Promise.resolve("OK");
    }),

    del: mock((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
    }),
};

function resetState() {
    store.clear();
    failNextGet = false;
    _resetRedisKvStoreForTesting();
    _injectRedisForTesting(mockRedisClient);
    _resetRunnerSecretsForTesting();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emitToRunner", () => {
    test("delivers service_message to a local runner once via its room", () => {
        let roomDeliveries = 0;
        const localSocket = { connected: true, rooms: new Set([runnerRoom("runner-local")]), emit: mock(() => {}) } as any;
        localRunnerSockets.set("runner-local", localSocket);
        initSioRegistry({
            of: () => ({
                to: (room: string) => ({
                    emit: (event: string, data: unknown) => {
                        expect(room).toBe(runnerRoom("runner-local"));
                        expect(event).toBe("service_message");
                        expect(data).toEqual({ requestId: "req-1" });
                        roomDeliveries++;
                    },
                }),
            }),
        } as any);

        emitToRunner("runner-local", "service_message", { requestId: "req-1" });

        expect(roomDeliveries).toBe(1);
        expect(localSocket.emit).not.toHaveBeenCalled();
        localRunnerSockets.clear();
    });

    test("delivers to an unjoined local runner exactly once via direct fallback", () => {
        let UNJOINED_LOCAL_DELIVERIES = 0;
        const localSocket = {
            connected: true,
            rooms: new Set<string>(),
            emit: mock(() => {
                UNJOINED_LOCAL_DELIVERIES++;
            }),
        } as any;
        localRunnerSockets.set("runner-unjoined", localSocket);
        initSioRegistry({
            of: () => ({
                to: (room: string) => ({
                    emit: (event: string, data: unknown) => {
                        expect(room).toBe(runnerRoom("runner-unjoined"));
                        expect(event).toBe("session_ended");
                        expect(data).toEqual({ sessionId: "session-1" });
                        // An unjoined local socket is not reached by the room emit.
                    },
                }),
            }),
        } as any);

        emitToRunner("runner-unjoined", "session_ended", { sessionId: "session-1" });

        expect(UNJOINED_LOCAL_DELIVERIES).toBe(1);
        expect(localSocket.emit).toHaveBeenCalledTimes(1);
        localRunnerSockets.clear();
    });

    test("falls back directly when a joined local runner room emit fails", () => {
        const localSocket = {
            connected: true,
            rooms: new Set([runnerRoom("runner-failed-room")]),
            emit: mock(() => {}),
        } as any;
        localRunnerSockets.set("runner-failed-room", localSocket);
        initSioRegistry({
            of: () => ({
                to: () => ({
                    emit: () => {
                        throw new Error("adapter unavailable");
                    },
                }),
            }),
        } as any);

        emitToRunner("runner-failed-room", "service_message", { requestId: "req-2" });

        expect(localSocket.emit).toHaveBeenCalledTimes(1);
        localRunnerSockets.clear();
    });
});

describe("runner secret persistence", () => {
    beforeEach(resetState);

    test("claims and persists a new runner secret", async () => {
        const result = await validateAndPersistRunnerSecret("runner-1", "secret-1");
        expect(result).toBe("claimed");
        expect(runnerSecrets.get("runner-1")).toBe("secret-1");
        expect(await getRunnerSecret("runner-1")).toBe("secret-1");
    });

    test("rejects a mismatched secret", async () => {
        await validateAndPersistRunnerSecret("runner-2", "secret-2");
        const result = await validateAndPersistRunnerSecret("runner-2", "wrong");
        expect(result).toBe("mismatch");
    });

    test("matches a previously stored secret from local cache", async () => {
        await validateAndPersistRunnerSecret("runner-3", "secret-3");
        const result = await validateAndPersistRunnerSecret("runner-3", "secret-3");
        expect(result).toBe("match");
    });

    test("loads a secret from Redis when local cache misses", async () => {
        store.set("pizzapi:runner:secret:runner-4", "secret-4");
        const result = await validateAndPersistRunnerSecret("runner-4", "secret-4");
        expect(result).toBe("match");
        expect(runnerSecrets.get("runner-4")).toBe("secret-4");
    });

    test("falls back to in-memory store when Redis is disabled", async () => {
        const previous = process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_REDIS_URL = "off";
        _resetRedisKvStoreForTesting();
        _resetRunnerSecretsForTesting();

        const result = await validateAndPersistRunnerSecret("runner-disabled", "secret-d");
        expect(result).toBe("claimed");
        expect(runnerSecrets.get("runner-disabled")).toBe("secret-d");

        const mismatch = await validateAndPersistRunnerSecret("runner-disabled", "wrong");
        expect(mismatch).toBe("mismatch");

        process.env.PIZZAPI_REDIS_URL = previous;
    });

    test("concurrent first claims for the same runnerId never both win with different secrets", async () => {
        // Regression for GM EqNrZtr1: interleaved first-claim calls used to
        // both read "no stored secret" before either wrote one, letting two
        // different secrets both come back "claimed" for the same runnerId.
        const results = await Promise.all([
            validateAndPersistRunnerSecret("runner-race", "secret-a"),
            validateAndPersistRunnerSecret("runner-race", "secret-b"),
        ]);

        const claimedCount = results.filter((r) => r === "claimed").length;
        expect(claimedCount).toBe(1);
        expect(results.sort()).toEqual(["claimed", "mismatch"]);

        // The winner's secret is the one actually persisted.
        const winnerSecret = results[0] === "claimed" ? "secret-a" : "secret-b";
        expect(runnerSecrets.get("runner-race")).toBe(winnerSecret);
        expect(store.get("pizzapi:runner:secret:runner-race")).toBe(winnerSecret);
    });

    test("a Redis GET failure after a lost NX race fails closed instead of overwriting the winner", async () => {
        // Regression (P1): getValue() returns null both when a key is
        // missing AND when the GET call itself errors. The old fallback
        // treated both the same and fell through to an unconditional SET,
        // letting a losing racer whose follow-up GET merely failed clobber
        // the legitimate owner's already-persisted secret.
        const winner = await validateAndPersistRunnerSecret("runner-fail-get", "secret-winner");
        expect(winner).toBe("claimed");

        // Simulate a second claimant with no local cache (e.g. a different
        // process, or this one after a cache miss): its NX loses because the
        // key already exists, and the follow-up GET then fails.
        _resetRunnerSecretsForTesting();
        failNextGet = true;

        await expect(
            validateAndPersistRunnerSecret("runner-fail-get", "secret-attacker"),
        ).rejects.toThrow();

        // The legitimate secret must still be the one stored, both in Redis
        // and in the local cache — never overwritten by the failed claimant.
        expect(store.get("pizzapi:runner:secret:runner-fail-get")).toBe("secret-winner");
        expect(runnerSecrets.get("runner-fail-get")).toBeUndefined();
    });

    test("a missing key after a lost NX race retries the claim instead of blindly SETting", async () => {
        // The key can legitimately vanish between a failed NX and the
        // follow-up GET (e.g. a concurrent deleteRunnerSecret). The retry
        // must re-run the atomic NX rather than unconditionally writing, so
        // whichever caller's retry actually wins is the one Redis accepted.
        const first = await validateAndPersistRunnerSecret("runner-vanish", "secret-x");
        expect(first).toBe("claimed");

        _resetRunnerSecretsForTesting();
        // Make the GET right after the (losing) NX come back empty exactly
        // once, simulating the key being deleted between the failed NX and
        // the read, then behave normally so the retry can actually converge.
        const key = "pizzapi:runner:secret:runner-vanish";
        let forcedMissOnce = true;
        const originalGetImpl = mockRedisClient.get;
        (mockRedisClient as any).get = mock((k: string) => {
            if (k === key && forcedMissOnce) {
                forcedMissOnce = false;
                return Promise.resolve(null);
            }
            return Promise.resolve(store.get(k) ?? null);
        });

        let result: string;
        try {
            result = await validateAndPersistRunnerSecret("runner-vanish", "secret-y");
        } finally {
            (mockRedisClient as any).get = originalGetImpl;
        }

        // The retry re-ran the atomic NX against the still-present "secret-x"
        // key, so it correctly reports mismatch rather than blindly winning.
        expect(result).toBe("mismatch");
        expect(store.get(key)).toBe("secret-x");
    });
});

describe("claimChains cleanup", () => {
    beforeEach(resetState);

    test("drops the per-runnerId chain once the claim settles", async () => {
        // Regression (P2): claimChains kept every runnerId's settled promise
        // forever, growing unbounded across the server's lifetime.
        await validateAndPersistRunnerSecret("runner-chain-gc", "secret-1");
        // The settle callback runs in a microtask after the awaited promise
        // resolves, so give it a couple more ticks to fire.
        await Promise.resolve();
        await Promise.resolve();
        expect(_claimChainsForTesting().has("runner-chain-gc")).toBe(false);
    });

    test("a slower, still-settling newer chain is not dropped by an older chain's cleanup", async () => {
        // Identity check: queue two claims for the same runnerId back to
        // back. The first settles and tries to delete its map entry — it
        // must not delete the second (newer) chain that replaced it.
        const first = validateAndPersistRunnerSecret("runner-chain-order", "secret-1");
        const second = validateAndPersistRunnerSecret("runner-chain-order", "secret-2");
        await Promise.all([first, second]);
        await Promise.resolve();
        await Promise.resolve();
        expect(_claimChainsForTesting().has("runner-chain-order")).toBe(false);
    });
});
