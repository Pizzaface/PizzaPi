import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { getKysely, createTestDatabase, _setKyselyForTest } from "./auth.js";
import { unsubscribePush, updateSuppressChildNotifications, getSubscriptionsForUser, isValidPushEndpoint } from "./push.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use a temp directory so the test is portable (CI runners have read-only working dirs)
const tmpDir = mkdtempSync(join(tmpdir(), "push-test-"));
const tmpDbPath = join(tmpDir, "test.db");

// Own Kysely instance — immune to other test files clobbering the singleton.
const testDb = createTestDatabase(tmpDbPath);

beforeAll(async () => {
    _setKyselyForTest(testDb);

    await getKysely().schema
        .createTable("push_subscription")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("endpoint", "text", (col) => col.notNull())
        .addColumn("keys", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("enabledEvents", "text", (col) => col.notNull().defaultTo("*"))
        .addColumn("suppressChildNotifications", "integer", (col) => col.notNull().defaultTo(0))
        .execute();
});

// Re-pin before every test — another file's beforeAll may have overwritten _kysely.
beforeEach(() => {
    _setKyselyForTest(testDb);
});

afterEach(async () => {
    await getKysely().deleteFrom("push_subscription" as any).execute();
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});


describe("unsubscribePush", () => {
    it("returns true when a matching subscription is deleted", async () => {
        const db = getKysely();
        const now = new Date().toISOString();
        await db
            .insertInto("push_subscription" as any)
            .values({
                id: "sub-1",
                userId: "user-1",
                endpoint: "https://example.com/push/1",
                keys: "{}",
                createdAt: now,
                enabledEvents: "*",
            })
            .execute();

        const result = await unsubscribePush("user-1", "https://example.com/push/1");
        expect(result).toBe(true);
    });

    it("returns false when no matching subscription exists", async () => {
        const result = await unsubscribePush("user-1", "https://example.com/push/nonexistent");
        expect(result).toBe(false);
    });

    it("returns false when userId does not match", async () => {
        const db = getKysely();
        const now = new Date().toISOString();
        await db
            .insertInto("push_subscription" as any)
            .values({
                id: "sub-2",
                userId: "user-1",
                endpoint: "https://example.com/push/2",
                keys: "{}",
                createdAt: now,
                enabledEvents: "*",
            })
            .execute();

        const result = await unsubscribePush("wrong-user", "https://example.com/push/2");
        expect(result).toBe(false);
    });
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function insertSub(id: string, userId: string, endpoint: string, suppress = false) {
    await getKysely()
        .insertInto("push_subscription" as any)
        .values({
            id,
            userId,
            endpoint,
            keys: "{}",
            createdAt: new Date().toISOString(),
            enabledEvents: "*",
            suppressChildNotifications: suppress ? 1 : 0,
        })
        .execute();
}

// ── updateSuppressChildNotifications ──────────────────────────────────────────

describe("updateSuppressChildNotifications", () => {
    it("sets suppressChildNotifications to true for the matching subscription", async () => {
        await insertSub("sub-scn-1", "user-1", "https://example.com/push/scn-1");

        await updateSuppressChildNotifications("user-1", "https://example.com/push/scn-1", true);

        const subs = await getSubscriptionsForUser("user-1");
        expect(subs).toHaveLength(1);
        expect(subs[0].suppressChildNotifications).toBe(1);
    });

    it("sets suppressChildNotifications back to false", async () => {
        await insertSub("sub-scn-2", "user-2", "https://example.com/push/scn-2", true);

        await updateSuppressChildNotifications("user-2", "https://example.com/push/scn-2", false);

        const subs = await getSubscriptionsForUser("user-2");
        expect(subs).toHaveLength(1);
        expect(subs[0].suppressChildNotifications).toBe(0);
    });

    it("does not affect other users' subscriptions", async () => {
        await insertSub("sub-scn-3a", "user-3a", "https://example.com/push/scn-3a");
        await insertSub("sub-scn-3b", "user-3b", "https://example.com/push/scn-3b");

        await updateSuppressChildNotifications("user-3a", "https://example.com/push/scn-3a", true);

        const subsA = await getSubscriptionsForUser("user-3a");
        const subsB = await getSubscriptionsForUser("user-3b");
        expect(subsA[0].suppressChildNotifications).toBe(1);
        expect(subsB[0].suppressChildNotifications).toBe(0);
    });

    it("does not affect subscriptions with a different endpoint for the same user", async () => {
        await insertSub("sub-scn-4a", "user-4", "https://example.com/push/scn-4a");
        await insertSub("sub-scn-4b", "user-4", "https://example.com/push/scn-4b");

        await updateSuppressChildNotifications("user-4", "https://example.com/push/scn-4a", true);

        const subs = await getSubscriptionsForUser("user-4");
        const subA = subs.find((s) => s.endpoint === "https://example.com/push/scn-4a");
        const subB = subs.find((s) => s.endpoint === "https://example.com/push/scn-4b");
        expect(subA?.suppressChildNotifications).toBe(1);
        expect(subB?.suppressChildNotifications).toBe(0);
    });
});

    it("returns 0 when no matching subscription exists", async () => {
        const count = await updateSuppressChildNotifications("user-x", "https://example.com/push/nonexistent", true);
        expect(count).toBe(0);
    });

    it("returns 1 when the subscription is updated", async () => {
        await insertSub("sub-scn-5", "user-5", "https://example.com/push/scn-5");
        const count = await updateSuppressChildNotifications("user-5", "https://example.com/push/scn-5", true);
        expect(count).toBe(1);
    });

    it("returns 0 when userId does not match endpoint", async () => {
        await insertSub("sub-scn-6", "user-6a", "https://example.com/push/scn-6");
        const count = await updateSuppressChildNotifications("user-6b", "https://example.com/push/scn-6", true);
        expect(count).toBe(0);
    });

// ── isValidPushEndpoint ───────────────────────────────────────────────────────

describe("isValidPushEndpoint", () => {
    // ── Valid cases ───────────────────────────────────────────────────────────

    it("accepts HTTPS endpoints on known push service hosts", () => {
        expect(isValidPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
        expect(isValidPushEndpoint("https://updates.push.services.mozilla.com/push/v1/abc")).toBe(true);
        expect(isValidPushEndpoint("https://api.push.apple.com/3/device/abc")).toBe(true);
    });

    it("accepts valid HTTPS endpoints outside the known-hosts list (e.g. enterprise/custom proxies)", () => {
        // These are legitimate HTTPS push providers that are NOT in the baked-in
        // allowlist. They must be accepted — blocking them is an over-aggressive
        // compatibility break (regression fixed by this PR).
        expect(isValidPushEndpoint("https://push.example.com/sub/abc123")).toBe(true);
        expect(isValidPushEndpoint("https://mypush.internal.corp.example.com/sub/abc")).toBe(true);
        expect(isValidPushEndpoint("https://custom-push-proxy.acme.org/push/v2/token")).toBe(true);
    });

    it("accepts HTTPS endpoints with ports", () => {
        expect(isValidPushEndpoint("https://push.example.com:8443/sub/token")).toBe(true);
    });

    // ── Invalid cases — scheme ────────────────────────────────────────────────

    it("rejects HTTP endpoints (not HTTPS)", () => {
        expect(isValidPushEndpoint("http://fcm.googleapis.com/push/abc")).toBe(false);
        expect(isValidPushEndpoint("http://push.example.com/sub/abc")).toBe(false);
    });

    it("rejects non-HTTP(S) schemes", () => {
        expect(isValidPushEndpoint("ftp://push.example.com/sub/abc")).toBe(false);
        expect(isValidPushEndpoint("ws://push.example.com/sub/abc")).toBe(false);
    });

    // ── Invalid cases — private / loopback IPs (SSRF protection) ────────────

    it("rejects loopback IPv4 (127.x.x.x)", () => {
        expect(isValidPushEndpoint("https://127.0.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://127.1.2.3/push")).toBe(false);
    });

    it("rejects RFC1918 private IPv4 ranges", () => {
        expect(isValidPushEndpoint("https://10.0.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://192.168.1.100/push")).toBe(false);
        expect(isValidPushEndpoint("https://172.16.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://172.31.255.255/push")).toBe(false);
    });

    it("rejects link-local IPv4 (169.254.x.x)", () => {
        expect(isValidPushEndpoint("https://169.254.1.1/push")).toBe(false);
    });

    it("rejects IPv6 loopback (::1)", () => {
        expect(isValidPushEndpoint("https://[::1]/push")).toBe(false);
    });

    it("rejects IPv6 ULA (fc00::/7) — fc** prefix", () => {
        expect(isValidPushEndpoint("https://[fc00::1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[fc12:3456::1]/push")).toBe(false);
    });

    it("rejects IPv6 ULA (fd00::/8) — fd** prefix", () => {
        expect(isValidPushEndpoint("https://[fd00::1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[fd12:3456::1]/push")).toBe(false);
    });

    it("rejects IPv6 link-local (fe80::/10)", () => {
        expect(isValidPushEndpoint("https://[fe80::1]/push")).toBe(false);
    });

    // ── Invalid cases — malformed ────────────────────────────────────────────

    it("rejects non-URL strings", () => {
        expect(isValidPushEndpoint("not-a-url")).toBe(false);
        expect(isValidPushEndpoint("")).toBe(false);
        expect(isValidPushEndpoint("://missing-scheme")).toBe(false);
    });

    // ── localhost hostname (Round 3 regression) ───────────────────────────

    it("rejects 'localhost' hostname (case-insensitive)", () => {
        expect(isValidPushEndpoint("https://localhost/push")).toBe(false);
        expect(isValidPushEndpoint("https://LOCALHOST/push")).toBe(false);
        expect(isValidPushEndpoint("https://Localhost/push")).toBe(false);
    });

    it("rejects .localhost subdomains", () => {
        expect(isValidPushEndpoint("https://foo.localhost/push")).toBe(false);
        expect(isValidPushEndpoint("https://my.service.localhost/push")).toBe(false);
    });

    it("accepts hostnames that contain 'localhost' as a non-.localhost substring", () => {
        // "notlocalhost.example.com" is not equal to "localhost" and does not
        // end with ".localhost", so it should be accepted.
        expect(isValidPushEndpoint("https://notlocalhost.example.com/push")).toBe(true);
    });

    // ── IPv4-mapped IPv6 (Round 3 regression) ────────────────────────────

    it("rejects IPv4-mapped IPv6 loopback (::ffff:127.x.x.x)", () => {
        expect(isValidPushEndpoint("https://[::ffff:127.0.0.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:127.1.2.3]/push")).toBe(false);
    });

    it("rejects IPv4-mapped IPv6 for RFC1918 private ranges", () => {
        expect(isValidPushEndpoint("https://[::ffff:192.168.1.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:10.0.0.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:172.16.0.1]/push")).toBe(false);
    });

    it("accepts IPv4-mapped IPv6 for public IPs (no over-blocking)", () => {
        expect(isValidPushEndpoint("https://[::ffff:8.8.8.8]/push")).toBe(true);
    });

    // ── All-interfaces bind addresses ────────────────────────────────────

    it("rejects IPv6 all-interfaces bind address ([::])", () => {
        expect(isValidPushEndpoint("https://[::]/push")).toBe(false);
    });

    it("rejects 0.0.0.0 (IPv4 all-interfaces bind address)", () => {
        expect(isValidPushEndpoint("https://0.0.0.0/push")).toBe(false);
    });
});
