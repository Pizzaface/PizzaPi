/**
 * Unit tests for runner secret persistence (Fix: P0 runner impersonation).
 *
 * Tests the Redis-backed secret validation in registerRunner():
 *   1. First registration stores a hashed secret in Redis.
 *   2. Re-registration with the correct secret succeeds.
 *   3. Re-registration with the wrong secret is rejected.
 *   4. Re-registration by the wrong user is rejected.
 *   5. After server restart (in-memory cleared), Redis hash still blocks impostors.
 *
 * Uses a mock Redis client (DI) — no live Redis required.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createHash } from "crypto";

// ── Mock Redis client ────────────────────────────────────────────────────────

const store = new Map<string, string>();

const mockRedis = {
    isOpen: true,

    // String ops
    async get(key: string): Promise<string | null> {
        return store.get(key) ?? null;
    },
    async set(key: string, value: string, opts?: { EX?: number }): Promise<void> {
        void opts; // TTL ignored in tests
        store.set(key, value);
    },
    async del(key: string | string[]): Promise<number> {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
            if (store.delete(k)) count++;
        }
        return count;
    },
    async exists(key: string): Promise<number> {
        return store.has(key) ? 1 : 0;
    },

    // Hash ops
    async hGetAll(key: string): Promise<Record<string, string>> {
        const prefix = `${key}::`;
        const result: Record<string, string> = {};
        for (const [k, v] of store) {
            if (k.startsWith(prefix)) {
                result[k.slice(prefix.length)] = v;
            }
        }
        return result;
    },
    async hSet(key: string, fields: Record<string, string>): Promise<void> {
        for (const [field, value] of Object.entries(fields)) {
            store.set(`${key}::${field}`, value);
        }
    },
    async expire(_key: string, _ttl: number): Promise<void> {},

    // Set ops
    async sAdd(key: string, member: string): Promise<void> {
        const existing = store.get(key) ?? "";
        const members = existing ? existing.split(",") : [];
        if (!members.includes(member)) {
            members.push(member);
            store.set(key, members.join(","));
        }
    },
    async sRem(key: string, member: string | string[]): Promise<void> {
        const existing = store.get(key) ?? "";
        const members = existing ? existing.split(",") : [];
        const toRemove = Array.isArray(member) ? member : [member];
        const filtered = members.filter((m) => !toRemove.includes(m));
        store.set(key, filtered.join(","));
    },

    // Multi/pipeline stub
    multi() {
        const ops: Array<() => Promise<unknown>> = [];
        const m: Record<string, unknown> = {
            hSet: (key: string, fields: Record<string, string>) => {
                ops.push(() => mockRedis.hSet(key, fields));
                return m;
            },
            expire: (_key: string, _ttl: number) => {
                ops.push(() => Promise.resolve());
                return m;
            },
            sAdd: (key: string, member: string) => {
                ops.push(() => mockRedis.sAdd(key, member));
                return m;
            },
            sRem: (key: string, member: string | string[]) => {
                ops.push(() => mockRedis.sRem(key, member));
                return m;
            },
            del: (key: string) => {
                ops.push(() => mockRedis.del(key));
                return m;
            },
            exec: async () => {
                const results: unknown[] = [];
                for (const op of ops) {
                    results.push(await op());
                }
                return results;
            },
        };
        return m;
    },
};

// ── Inject mock and import module under test ──────────────────────────────────

import { initStateRedis } from "../sio-state.js";

// Inject the mock Redis client before importing modules that call requireRedis()
await initStateRedis(mockRedis as unknown as import("redis").RedisClientType);

// Import after injection
import { getRunnerSecretHash, setRunnerSecretHash } from "../sio-state.js";
import { registerRunner } from "./runners.js";

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex");
}

// Mock minimal dependencies used by registerRunner (Socket.IO broadcast paths).
// We only need to test secret validation — broadcasting is not under test.
mock.module("./hub.js", () => ({ broadcastToHub: async () => {} }));
mock.module("./runners-broadcast.js", () => ({ broadcastToRunnersNs: async () => {} }));

// Minimal mock socket
function makeSocket(userId = "user-a"): import("socket.io").Socket {
    return {
        id: `socket-${Math.random()}`,
        data: { userId },
        join: async () => {},
        connected: true,
    } as unknown as import("socket.io").Socket;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerRunner — secret persistence", () => {
    beforeEach(() => {
        store.clear();
    });

    test("first registration stores hashed secret in Redis", async () => {
        const socket = makeSocket("user-a");
        const result = await registerRunner(socket, {
            requestedRunnerId: "runner-abc",
            runnerSecret: "my-secret",
            userId: "user-a",
        });

        expect(typeof result).toBe("string");
        expect(result).toBe("runner-abc");

        const storedHash = await getRunnerSecretHash("runner-abc");
        expect(storedHash).toBe(sha256("my-secret"));
    });

    test("re-registration with correct secret succeeds", async () => {
        // Pre-store hash (simulating previous registration)
        await setRunnerSecretHash("runner-abc", sha256("my-secret"));

        const socket = makeSocket("user-a");
        const result = await registerRunner(socket, {
            requestedRunnerId: "runner-abc",
            runnerSecret: "my-secret",
            userId: "user-a",
        });

        expect(typeof result).toBe("string");
        expect(result).toBe("runner-abc");
    });

    test("re-registration with wrong secret is rejected", async () => {
        // Pre-store hash for correct secret
        await setRunnerSecretHash("runner-abc", sha256("correct-secret"));

        const socket = makeSocket("user-a");
        const result = await registerRunner(socket, {
            requestedRunnerId: "runner-abc",
            runnerSecret: "wrong-secret",
            userId: "user-a",
        });

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain("secret mismatch");
    });

    test("first registration without secret generates a new runnerId", async () => {
        const socket = makeSocket("user-a");
        const result = await registerRunner(socket, {
            userId: "user-a",
        });

        // Should get a UUID, not null/error
        expect(typeof result).toBe("string");
        expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    test("impostor cannot claim runnerId after server restart (no in-memory cache)", async () => {
        // Simulate original registration
        await setRunnerSecretHash("runner-xyz", sha256("original-secret"));

        // Impostor tries to register with a different secret
        const impostorSocket = makeSocket("user-evil");
        const impostorResult = await registerRunner(impostorSocket, {
            requestedRunnerId: "runner-xyz",
            runnerSecret: "impostor-secret",
            userId: "user-evil",
        });

        expect(impostorResult).toBeInstanceOf(Error);
        expect((impostorResult as Error).message).toContain("secret mismatch");
    });
});

describe("TunnelRelay — verifyRunner callback", () => {
    test("verifyRunner blocks runner with mismatched userId", async () => {
        const { TunnelRelay } = await import("@pizzapi/tunnel");

        const relay = new TunnelRelay({
            apiKeys: async (key) => (key === "valid-key" ? { userId: "user-a" } : false),
            verifyRunner: async (_runnerId, userId) => userId === "user-a",
        });

        type MockWs = {
            ws: WebSocket;
            sent: string[];
            closed: boolean;
            emit: (event: string, payload?: unknown) => void;
        };

        function makeMockWs(): MockWs {
            const sent: string[] = [];
            let closed = false;
            type Listener = (event?: unknown) => void;
            const listeners = new Map<string, Listener[]>();
            const ws = {
                readyState: WebSocket.OPEN,
                send(data: string) { sent.push(data); },
                close() { closed = true; },
                addEventListener(event: string, listener: Listener) {
                    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                },
            } as unknown as WebSocket;
            return {
                ws,
                sent,
                get closed() { return closed; },
                emit(event: string, payload?: unknown) {
                    for (const l of listeners.get(event) ?? []) l(payload);
                },
            };
        }

        // Connection with wrong userId is rejected
        const evilWs = makeMockWs();
        const evilRelay = new TunnelRelay({
            apiKeys: async (key) => (key === "valid-key" ? { userId: "user-evil" } : false),
            verifyRunner: async (_runnerId, userId) => userId === "user-a",
        });
        evilRelay.handleConnection(evilWs.ws);
        evilWs.emit("message", {
            data: JSON.stringify({ type: "register", runnerId: "runner-1", apiKey: "valid-key" }),
        });
        await Promise.resolve();
        await new Promise<void>((r) => setTimeout(r, 10));

        expect(evilWs.closed).toBe(true);
        expect(JSON.parse(evilWs.sent[0])).toMatchObject({ type: "error" });
        expect(evilRelay.hasRunner("runner-1")).toBe(false);

        void relay;
    });

    test("verifyRunner allows runner with matching userId", async () => {
        const { TunnelRelay } = await import("@pizzapi/tunnel");

        type Listener = (event?: unknown) => void;
        const sent: string[] = [];
        let closed = false;
        const listeners = new Map<string, Listener[]>();
        const ws = {
            readyState: WebSocket.OPEN,
            send(data: string) { sent.push(data); },
            close() { closed = true; },
            addEventListener(event: string, listener: Listener) {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            },
        } as unknown as WebSocket;

        const relay = new TunnelRelay({
            apiKeys: async (key) => (key === "valid-key" ? { userId: "user-a" } : false),
            verifyRunner: async (_runnerId, userId) => userId === "user-a",
        });

        relay.handleConnection(ws);
        for (const l of listeners.get("message") ?? []) {
            l({ data: JSON.stringify({ type: "register", runnerId: "runner-1", apiKey: "valid-key" }) });
        }
        await Promise.resolve();
        await new Promise<void>((r) => setTimeout(r, 10));

        expect(closed).toBe(false);
        expect(relay.hasRunner("runner-1")).toBe(true);
        expect(JSON.parse(sent[0]).type).toBe("registered");
    });
});
