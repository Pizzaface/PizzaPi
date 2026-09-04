import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    runnerSecrets,
    validateAndPersistRunnerSecret,
    getRunnerSecret,
    _resetRunnerSecretsForTesting,
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

const mockRedisClient = {
    isOpen: true,

    get: mock((key: string) => {
        return Promise.resolve(store.get(key) ?? null);
    }),

    set: mock((key: string, value: string, _opts?: unknown) => {
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
});
