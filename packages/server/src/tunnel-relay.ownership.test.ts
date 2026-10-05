/**
 * Tunnel registration must honour the DURABLE runner owner, not only the
 * ephemeral live runner state (which is deleted on disconnect). Otherwise a
 * different tenant with a valid API key can register a tunnel for an offline
 * runner's ID and capture traffic routed to it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const liveRunners = new Map<string, { runnerId: string; userId: string | null }>();

const actualRegistry = await import("./ws/sio-registry.js");
mock.module("./ws/sio-registry.js", () => ({
    ...actualRegistry,
    getRunnerData: async (id: string) => liveRunners.get(id) ?? null,
}));

const { createTestAuthContext, runWithAuthContext, getKysely } = await import("./auth.js");
const { runAllMigrations } = await import("./migrations.js");
const { mintEphemeralApiKey } = await import("./routes/utils.js");
const { rememberRunnerOwner, getRunnerOwner, claimRunnerOwner } = await import("./runner-owner.js");
const { authorizeTunnelRegistration } = await import("./tunnel-relay.js");

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-tunnel-owner-"));
const ctx = createTestAuthContext({ dbPath: join(tmpDir, "test.db"), baseURL: "http://localhost:7492" });
let keyA = "";
let keyB = "";
let userA = "";
let userB = "";

const inCtx = <T>(fn: () => Promise<T>) => runWithAuthContext(ctx, fn);

beforeAll(async () => {
    await runAllMigrations(ctx);
    await inCtx(async () => {
        const now = new Date();
        for (const [id, email] of [["user-a", "a@example.com"], ["user-b", "b@example.com"]] as const) {
            await getKysely()
                .insertInto("user")
                .values({ id, name: id, email, emailVerified: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() } as never)
                .execute();
        }
        userA = "user-a";
        userB = "user-b";
        keyA = await mintEphemeralApiKey(userA, "a", 600);
        keyB = await mintEphemeralApiKey(userB, "b", 600);
    });
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
    liveRunners.clear();
    await inCtx(async () => {
        await getKysely().deleteFrom("runner_owner").execute();
    });
});

describe("authorizeTunnelRegistration — durable runner ownership", () => {
    test("owner may register a tunnel for its offline runner", async () => {
        await inCtx(() => rememberRunnerOwner("runner-1", userA));
        expect(await inCtx(() => authorizeTunnelRegistration(keyA, "runner-1"))).toBe(userA);
    });

    test("another user cannot register a tunnel for an offline runner it does not own", async () => {
        await inCtx(() => rememberRunnerOwner("runner-1", userA));
        // No live state: the runner is offline.
        expect(await inCtx(() => authorizeTunnelRegistration(keyB, "runner-1"))).toBeNull();
        expect(await inCtx(() => getRunnerOwner("runner-1"))).toBe(userA);
    });

    test("another user cannot register a tunnel for a live runner it does not own", async () => {
        liveRunners.set("runner-live", { runnerId: "runner-live", userId: userA });
        expect(await inCtx(() => authorizeTunnelRegistration(keyB, "runner-live"))).toBeNull();
    });

    test("tunnel-first registration cannot claim an unrecognized runner ID (no durable or live owner)", async () => {
        // e.g. an offline runner that predates the durable owner table: the
        // tunnel handshake carries no runner secret, so it must not claim.
        expect(await inCtx(() => authorizeTunnelRegistration(keyB, "runner-new"))).toBeNull();
        expect(await inCtx(() => getRunnerOwner("runner-new"))).toBeNull();

        // The legitimate runner then registers over Socket.IO (with its
        // secret), which records the durable owner…
        expect(await inCtx(() => claimRunnerOwner("runner-new", userA))).toBe("owned");
        // …and its tunnel registration now succeeds, while others stay out.
        expect(await inCtx(() => authorizeTunnelRegistration(keyA, "runner-new"))).toBe(userA);
        expect(await inCtx(() => authorizeTunnelRegistration(keyB, "runner-new"))).toBeNull();
    });

    test("a live runner registered by the caller is accepted even before its durable record lands", async () => {
        liveRunners.set("runner-live-a", { runnerId: "runner-live-a", userId: userA });
        expect(await inCtx(() => authorizeTunnelRegistration(keyA, "runner-live-a"))).toBe(userA);
        // Tunnel registration never writes the durable owner itself.
        expect(await inCtx(() => getRunnerOwner("runner-live-a"))).toBeNull();
    });

    test("rejects an invalid API key", async () => {
        expect(await inCtx(() => authorizeTunnelRegistration("not-a-key", "runner-x"))).toBeNull();
    });

    test("fails closed when the durable owner store is unavailable", async () => {
        await inCtx(async () => {
            await getKysely().schema.alterTable("runner_owner").renameTo("runner_owner_offline").execute();
        });
        try {
            expect(await inCtx(() => authorizeTunnelRegistration(keyA, "runner-1"))).toBeNull();
        } finally {
            await inCtx(async () => {
                await getKysely().schema.alterTable("runner_owner_offline").renameTo("runner_owner").execute();
            });
        }
    });
});
