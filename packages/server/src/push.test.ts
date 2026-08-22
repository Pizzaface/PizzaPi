import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn } from "bun:test";
import { createTestAuthContext, getKysely, runWithAuthContext } from "./auth.js";
import { unsubscribePush, updateSuppressChildNotifications, getSubscriptionsForUser, isValidPushEndpoint, registerNativePush, unregisterNativePush, getNativeRegistrationsForUser, ensureNativePushRegistrationTable, sendPushToUser, updateNativeSuppressChildNotifications } from "./push.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use a temp directory so the test is portable (CI runners have read-only working dirs)
const tmpDir = mkdtempSync(join(tmpdir(), "push-test-"));
const tmpDbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath: tmpDbPath });
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);
const authIt = (name: string, fn: () => Promise<void> | void) => it(name, () => withAuth(fn));

beforeAll(async () => {
    await withAuth(async () => getKysely().schema
        .createTable("push_subscription")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("endpoint", "text", (col) => col.notNull())
        .addColumn("keys", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("enabledEvents", "text", (col) => col.notNull().defaultTo("*"))
        .addColumn("suppressChildNotifications", "integer", (col) => col.notNull().defaultTo(0))
        .execute());
    await withAuth(() => ensureNativePushRegistrationTable());
});

beforeEach(() => withAuth(() => undefined));

afterEach(async () => {
    await withAuth(() => getKysely().deleteFrom("push_subscription" as any).execute());
    await withAuth(() => getKysely().deleteFrom("native_push_registration" as any).execute());
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});


describe("unsubscribePush", () => {
    authIt("returns true when a matching subscription is deleted", async () => {
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

    authIt("returns false when no matching subscription exists", async () => {
        const result = await unsubscribePush("user-1", "https://example.com/push/nonexistent");
        expect(result).toBe(false);
    });

    authIt("returns false when userId does not match", async () => {
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
    authIt("sets suppressChildNotifications to true for the matching subscription", async () => {
        await insertSub("sub-scn-1", "user-1", "https://example.com/push/scn-1");

        await updateSuppressChildNotifications("user-1", "https://example.com/push/scn-1", true);

        const subs = await getSubscriptionsForUser("user-1");
        expect(subs).toHaveLength(1);
        expect(subs[0].suppressChildNotifications).toBe(1);
    });

    authIt("sets suppressChildNotifications back to false", async () => {
        await insertSub("sub-scn-2", "user-2", "https://example.com/push/scn-2", true);

        await updateSuppressChildNotifications("user-2", "https://example.com/push/scn-2", false);

        const subs = await getSubscriptionsForUser("user-2");
        expect(subs).toHaveLength(1);
        expect(subs[0].suppressChildNotifications).toBe(0);
    });

    authIt("does not affect other users' subscriptions", async () => {
        await insertSub("sub-scn-3a", "user-3a", "https://example.com/push/scn-3a");
        await insertSub("sub-scn-3b", "user-3b", "https://example.com/push/scn-3b");

        await updateSuppressChildNotifications("user-3a", "https://example.com/push/scn-3a", true);

        const subsA = await getSubscriptionsForUser("user-3a");
        const subsB = await getSubscriptionsForUser("user-3b");
        expect(subsA[0].suppressChildNotifications).toBe(1);
        expect(subsB[0].suppressChildNotifications).toBe(0);
    });

    authIt("does not affect subscriptions with a different endpoint for the same user", async () => {
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

    authIt("returns 0 when no matching subscription exists", async () => {
        const count = await updateSuppressChildNotifications("user-x", "https://example.com/push/nonexistent", true);
        expect(count).toBe(0);
    });

    authIt("returns 1 when the subscription is updated", async () => {
        await insertSub("sub-scn-5", "user-5", "https://example.com/push/scn-5");
        const count = await updateSuppressChildNotifications("user-5", "https://example.com/push/scn-5", true);
        expect(count).toBe(1);
    });

    authIt("returns 0 when userId does not match endpoint", async () => {
        await insertSub("sub-scn-6", "user-6a", "https://example.com/push/scn-6");
        const count = await updateSuppressChildNotifications("user-6b", "https://example.com/push/scn-6", true);
        expect(count).toBe(0);
    });

// ── isValidPushEndpoint ───────────────────────────────────────────────────────

describe("isValidPushEndpoint", () => {
    // ── Valid cases ───────────────────────────────────────────────────────────

    authIt("accepts HTTPS endpoints on known push service hosts", () => {
        expect(isValidPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
        expect(isValidPushEndpoint("https://updates.push.services.mozilla.com/push/v1/abc")).toBe(true);
        expect(isValidPushEndpoint("https://api.push.apple.com/3/device/abc")).toBe(true);
    });

    authIt("accepts valid HTTPS endpoints outside the known-hosts list (e.g. enterprise/custom proxies)", () => {
        // These are legitimate HTTPS push providers that are NOT in the baked-in
        // allowlist. They must be accepted — blocking them is an over-aggressive
        // compatibility break (regression fixed by this PR).
        expect(isValidPushEndpoint("https://push.example.com/sub/abc123")).toBe(true);
        expect(isValidPushEndpoint("https://mypush.internal.corp.example.com/sub/abc")).toBe(true);
        expect(isValidPushEndpoint("https://custom-push-proxy.acme.org/push/v2/token")).toBe(true);
    });

    authIt("accepts HTTPS endpoints with ports", () => {
        expect(isValidPushEndpoint("https://push.example.com:8443/sub/token")).toBe(true);
    });

    // ── Invalid cases — scheme ────────────────────────────────────────────────

    authIt("rejects HTTP endpoints (not HTTPS)", () => {
        expect(isValidPushEndpoint("http://fcm.googleapis.com/push/abc")).toBe(false);
        expect(isValidPushEndpoint("http://push.example.com/sub/abc")).toBe(false);
    });

    authIt("rejects non-HTTP(S) schemes", () => {
        expect(isValidPushEndpoint("ftp://push.example.com/sub/abc")).toBe(false);
        expect(isValidPushEndpoint("ws://push.example.com/sub/abc")).toBe(false);
    });

    // ── Invalid cases — private / loopback IPs (SSRF protection) ────────────

    authIt("rejects loopback IPv4 (127.x.x.x)", () => {
        expect(isValidPushEndpoint("https://127.0.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://127.1.2.3/push")).toBe(false);
    });

    authIt("rejects RFC1918 private IPv4 ranges", () => {
        expect(isValidPushEndpoint("https://10.0.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://192.168.1.100/push")).toBe(false);
        expect(isValidPushEndpoint("https://172.16.0.1/push")).toBe(false);
        expect(isValidPushEndpoint("https://172.31.255.255/push")).toBe(false);
    });

    authIt("rejects link-local IPv4 (169.254.x.x)", () => {
        expect(isValidPushEndpoint("https://169.254.1.1/push")).toBe(false);
    });

    authIt("rejects bare-integer and hex IPv4 forms of loopback", () => {
        // 2130706433 === 127.0.0.1; 0x7f000001 === 127.0.0.1
        expect(isValidPushEndpoint("https://2130706433/push")).toBe(false);
        expect(isValidPushEndpoint("https://0x7f000001/push")).toBe(false);
    });

    authIt("rejects IPv6 loopback (::1)", () => {
        expect(isValidPushEndpoint("https://[::1]/push")).toBe(false);
    });

    authIt("rejects IPv6 ULA (fc00::/7) — fc** prefix", () => {
        expect(isValidPushEndpoint("https://[fc00::1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[fc12:3456::1]/push")).toBe(false);
    });

    authIt("rejects IPv6 ULA (fd00::/8) — fd** prefix", () => {
        expect(isValidPushEndpoint("https://[fd00::1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[fd12:3456::1]/push")).toBe(false);
    });

    authIt("rejects IPv6 link-local (fe80::/10)", () => {
        expect(isValidPushEndpoint("https://[fe80::1]/push")).toBe(false);
    });

    // ── Invalid cases — malformed ────────────────────────────────────────────

    authIt("rejects non-URL strings", () => {
        expect(isValidPushEndpoint("not-a-url")).toBe(false);
        expect(isValidPushEndpoint("")).toBe(false);
        expect(isValidPushEndpoint("://missing-scheme")).toBe(false);
    });

    // ── localhost hostname (Round 3 regression) ───────────────────────────

    authIt("rejects 'localhost' hostname (case-insensitive)", () => {
        expect(isValidPushEndpoint("https://localhost/push")).toBe(false);
        expect(isValidPushEndpoint("https://LOCALHOST/push")).toBe(false);
        expect(isValidPushEndpoint("https://Localhost/push")).toBe(false);
    });

    authIt("rejects .localhost subdomains", () => {
        expect(isValidPushEndpoint("https://foo.localhost/push")).toBe(false);
        expect(isValidPushEndpoint("https://my.service.localhost/push")).toBe(false);
    });

    authIt("accepts hostnames that contain 'localhost' as a non-.localhost substring", () => {
        // "notlocalhost.example.com" is not equal to "localhost" and does not
        // end with ".localhost", so it should be accepted.
        expect(isValidPushEndpoint("https://notlocalhost.example.com/push")).toBe(true);
    });

    // ── IPv4-mapped IPv6 (Round 3 regression) ────────────────────────────

    authIt("rejects IPv4-mapped IPv6 loopback (::ffff:127.x.x.x)", () => {
        expect(isValidPushEndpoint("https://[::ffff:127.0.0.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:127.1.2.3]/push")).toBe(false);
    });

    authIt("rejects IPv4-mapped IPv6 for RFC1918 private ranges", () => {
        expect(isValidPushEndpoint("https://[::ffff:192.168.1.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:10.0.0.1]/push")).toBe(false);
        expect(isValidPushEndpoint("https://[::ffff:172.16.0.1]/push")).toBe(false);
    });

    authIt("accepts IPv4-mapped IPv6 for public IPs (no over-blocking)", () => {
        expect(isValidPushEndpoint("https://[::ffff:8.8.8.8]/push")).toBe(true);
    });

    // ── All-interfaces bind addresses ────────────────────────────────────

    authIt("rejects IPv6 all-interfaces bind address ([::])", () => {
        expect(isValidPushEndpoint("https://[::]/push")).toBe(false);
    });

    authIt("rejects 0.0.0.0 (IPv4 all-interfaces bind address)", () => {
        expect(isValidPushEndpoint("https://0.0.0.0/push")).toBe(false);
    });
});

// ── Native push (ntfy) ───────────────────────────────────────────────────────
//
// These tests cover the registration store + ntfy publish mapping. They mock
// `fetch` so no real network call is made (CI-safe). The ntfy branch is gated
// on PIZZAPI_NTFY_URL — tests set it via env to exercise the publish path.

describe("native push registration", () => {
    it("migration preserves suppression for existing native registrations", async () => {
        const migrationDir = mkdtempSync(join(tmpdir(), "push-migration-test-"));
        const migrationContext = createTestAuthContext({ dbPath: join(migrationDir, "test.db") });
        try {
            await runWithAuthContext(migrationContext, async () => {
                const db = getKysely();
                await db.schema
                    .createTable("native_push_registration")
                    .addColumn("id", "text", (col) => col.primaryKey())
                    .addColumn("userId", "text", (col) => col.notNull())
                    .addColumn("platform", "text", (col) => col.notNull())
                    .addColumn("topic", "text", (col) => col.notNull())
                    .addColumn("ntfyUser", "text")
                    .addColumn("ntfyPass", "text")
                    .addColumn("createdAt", "text", (col) => col.notNull())
                    .execute();
                await db
                    .insertInto("native_push_registration" as any)
                    .values({
                        id: "legacy-registration",
                        userId: "legacy-user",
                        platform: "android",
                        topic: "pizzapi-legacy",
                        ntfyUser: null,
                        ntfyPass: null,
                        createdAt: new Date().toISOString(),
                    })
                    .execute();

                await ensureNativePushRegistrationTable();

                const row = await db
                    .selectFrom("native_push_registration" as any)
                    .selectAll()
                    .where("id", "=", "legacy-registration")
                    .executeTakeFirstOrThrow();
                expect((row as any).suppressChildNotifications).toBe(1);
                await db.destroy();
            });
        } finally {
            rmSync(migrationDir, { recursive: true, force: true });
        }
    });

    authIt("registerNativePush assigns an unguessable topic and persists it", async () => {
        const reg = await registerNativePush({ userId: "user-A", platform: "android" });
        expect(reg.userId).toBe("user-A");
        expect(reg.platform).toBe("android");
        expect(reg.topic).toMatch(/^pizzapi-[0-9a-f]{48}$/);
        expect(reg.ntfyUser).toBeNull();
        expect(reg.ntfyPass).toBeNull();
        expect(reg.suppressChildNotifications).toBe(1);

        // Round-trips through the store.
        const rows = await getNativeRegistrationsForUser("user-A");
        expect(rows).toHaveLength(1);
        expect(rows[0].topic).toBe(reg.topic);
    });

    authIt("registerNativePush is idempotent per user+platform (reuses topic)", async () => {
        const first = await registerNativePush({ userId: "user-B", platform: "android" });
        const second = await registerNativePush({ userId: "user-B", platform: "android" });
        expect(second.topic).toBe(first.topic);
        const rows = await getNativeRegistrationsForUser("user-B");
        expect(rows).toHaveLength(1);
    });

    authIt("unregisterNativePush deletes the registration and reports removal", async () => {
        await registerNativePush({ userId: "user-C", platform: "android" });
        const removed = await unregisterNativePush("user-C", "android");
        expect(removed).toBe(true);
        const rows = await getNativeRegistrationsForUser("user-C");
        expect(rows).toHaveLength(0);

        // Second call reports no removal.
        const removed2 = await unregisterNativePush("user-C", "android");
        expect(removed2).toBe(false);
    });

    authIt("sendPushToUser is a no-op for ntfy when PIZZAPI_NTFY_URL is unset", async () => {
        // No ntfy env set in this process → branch should silently skip.
        // Register a row anyway; sendPushToUser must not throw and must not
        // attempt any fetch.
        await registerNativePush({ userId: "user-D", platform: "android" });
        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok")); };
        try {
            await sendPushToUser("user-D", {
                type: "agent_finished",
                title: "Agent finished",
                body: "done",
                sessionId: "sess-1",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
        }
        expect(fetchCalled).toBe(false);
    });

    authIt("sends native notifications only for input requests and completed agents", async () => {
        await registerNativePush({ userId: "user-native-events", platform: "android" });
        const originalNtfyUrl = process.env.PIZZAPI_NTFY_URL;
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => {
            fetchCalled = true;
            return Promise.resolve(new Response("ok", { status: 200 }));
        };
        try {
            for (const type of ["agent_error", "session_started", "session_ended"] as const) {
                await sendPushToUser("user-native-events", {
                    type,
                    title: "Unexpected alert",
                    body: "something happened",
                    sessionId: "sess-native-events",
                });
            }
        } finally {
            (globalThis as any).fetch = origFetch;
            if (originalNtfyUrl === undefined) delete process.env.PIZZAPI_NTFY_URL;
            else process.env.PIZZAPI_NTFY_URL = originalNtfyUrl;
        }

        expect(fetchCalled).toBe(false);
    });

    authIt("sendPushToUser publishes to ntfy with mapped headers when configured", async () => {
        await registerNativePush({ userId: "user-E", platform: "android" });
        const reg = (await getNativeRegistrationsForUser("user-E"))[0];

        // Enable the ntfy branch for this test only.
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        process.env.PIZZAPI_NTFY_PUBLIC_URL = "https://push.example.com";
        process.env.PIZZAPI_NTFY_PUBLISH_TOKEN = "tk_test_publish";
        process.env.PIZZAPI_BASE_URL = "https://relay.example.com";

        const captured: { url: string; init: RequestInit }[] = [];
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = (url: string, init: RequestInit) => {
            captured.push({ url, init });
            return Promise.resolve(new Response("ok", { status: 200 }));
        };
        try {
            await sendPushToUser("user-E", {
                type: "agent_needs_input",
                title: "Input needed",
                body: "Agent asks: ship it?",
                sessionId: "sess-2",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
            delete process.env.PIZZAPI_NTFY_PUBLIC_URL;
            delete process.env.PIZZAPI_NTFY_PUBLISH_TOKEN;
            delete process.env.PIZZAPI_BASE_URL;
        }

        expect(captured).toHaveLength(1);
        // JSON publish: POST to the ntfy base URL, topic carried in the body.
        expect(captured[0].url).toBe("http://ntfy-test");
        const headers = captured[0].init.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer tk_test_publish");
        expect(headers["content-type"]).toBe("application/json");
        const body = JSON.parse(String(captured[0].init.body));
        expect(body.topic).toBe(reg.topic);
        expect(body.title).toBe("Input needed");
        expect(body.priority).toBe(4); // high for agent_needs_input
        expect(body.message).toBe("Agent asks: ship it?");
        // Click deep link points at the relay web UI (PIZZAPI_BASE_URL), not ntfy.
        expect(body.click).toBe("https://relay.example.com/session/sess-2");
    });

    authIt("ntfy Title prefers sessionName so Android can group by conversation", async () => {
        await registerNativePush({ userId: "user-E2", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        process.env.PIZZAPI_NTFY_PUBLIC_URL = "https://push.example.com";

        const captured: { init: RequestInit }[] = [];
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = (_url: string, init: RequestInit) => {
            captured.push({ init });
            return Promise.resolve(new Response("ok", { status: 200 }));
        };
        try {
            await sendPushToUser("user-E2", {
                type: "agent_finished",
                title: "Agent finished",
                body: "Here's the summary of what I did.",
                sessionId: "sess-9",
                sessionName: "My Session",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
            delete process.env.PIZZAPI_NTFY_PUBLIC_URL;
        }

        expect(captured).toHaveLength(1);
        const body = JSON.parse(String(captured[0].init.body));
        expect(body.title).toBe("My Session");
    });

    authIt("publishes non-Latin-1 titles (emoji/CJK) via JSON body without throwing", async () => {
        await registerNativePush({ userId: "user-G", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        delete process.env.PIZZAPI_BASE_URL; // unset → click must be omitted, not point at ntfy

        const captured: { init: RequestInit }[] = [];
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = (_url: string, init: RequestInit) => {
            // Real fetch throws on non-ByteString HEADER values; a JSON body is safe.
            for (const v of Object.values((init.headers ?? {}) as Record<string, string>)) {
                if (/[^\u0000-\u00ff]/.test(v)) throw new TypeError("Invalid header value (non-ByteString)");
            }
            captured.push({ init });
            return Promise.resolve(new Response("ok", { status: 200 }));
        };
        try {
            await sendPushToUser("user-G", {
                type: "agent_finished",
                title: "fallback",
                body: "done",
                sessionId: "sess-emoji",
                sessionName: "🍕 会話 session",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }

        expect(captured).toHaveLength(1);
        const body = JSON.parse(String(captured[0].init.body));
        expect(body.title).toBe("🍕 会話 session");
        expect(body.click).toBeUndefined(); // PIZZAPI_BASE_URL unset → omitted
    });

    authIt("still sends native push when web push is suppressed for connected viewers", async () => {
        await registerNativePush({ userId: "user-connected", platform: "android" });
        await insertSub("sub-connected", "user-connected", "https://example.com/push/connected");
        await getKysely()
            .updateTable("push_subscription" as any)
            .set({ keys: "not-json" })
            .where("id", "=", "sub-connected")
            .execute();
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let ntfyPublishes = 0;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => {
            ntfyPublishes++;
            return Promise.resolve(new Response("ok", { status: 200 }));
        };
        try {
            await sendPushToUser("user-connected", {
                type: "agent_finished",
                title: "Agent finished",
                body: "done",
                sessionId: "sess-connected",
            }, false, true);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }

        expect(ntfyPublishes).toBe(1);
        // Malformed keys are pruned even under suppressWebPush (fix for C-005).
        expect(await getSubscriptionsForUser("user-connected")).toHaveLength(0);
    });

    authIt("sendPushToUser prunes ntfy registrations on 403/404", async () => {
        await registerNativePush({ userId: "user-F", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        process.env.PIZZAPI_NTFY_PUBLISH_TOKEN = "tk_test_publish";

        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () =>
            Promise.resolve(new Response("forbidden", { status: 403 }));
        try {
            await sendPushToUser("user-F", {
                type: "agent_finished",
                title: "done",
                body: "x",
                sessionId: "s",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
            delete process.env.PIZZAPI_NTFY_PUBLISH_TOKEN;
        }

        // The 403 should have pruned the registration.
        const rows = await getNativeRegistrationsForUser("user-F");
        expect(rows).toHaveLength(0);
    });

    authIt("sendPushToUser retries once on a 5xx ntfy failure then gives up and logs", async () => {
        await registerNativePush({ userId: "user-5xx", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let callCount = 0;
        const origFetch = globalThis.fetch;
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        (globalThis as any).fetch = () => {
            callCount++;
            return Promise.resolve(new Response("server error", { status: 503 }));
        };
        try {
            await sendPushToUser("user-5xx", {
                type: "agent_finished",
                title: "done",
                body: "x",
                sessionId: "s",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }

        // Single retry: one initial attempt + one retry, then give up.
        expect(callCount).toBe(2);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        // 5xx is transient, not "stale" — the registration must survive.
        const rows = await getNativeRegistrationsForUser("user-5xx");
        expect(rows).toHaveLength(1);
    });

    authIt("sendPushToUser does not retry on 403 (single fetch call) and prunes", async () => {
        await registerNativePush({ userId: "user-403-noretry", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let callCount = 0;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => {
            callCount++;
            return Promise.resolve(new Response("forbidden", { status: 403 }));
        };
        try {
            await sendPushToUser("user-403-noretry", {
                type: "agent_finished",
                title: "done",
                body: "x",
                sessionId: "s",
            });
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }

        // 403 is not transient (forbidden topic) — no retry, prune immediately.
        expect(callCount).toBe(1);
        const rows = await getNativeRegistrationsForUser("user-403-noretry");
        expect(rows).toHaveLength(0);
    });
});

// ── Child-session push suppression (isChildSession / suppressWebPush) ─────────
//
// Suppression silences SENDS but must not block stale-row pruning — malformed
// or expired subscription rows should be cleaned up regardless. The fix moves
// JSON.parse + stale collection BEFORE the suppression gate so:
//   • malformed-keys rows are pruned even when sends are suppressed
//   • sends are still blocked under isChildSession / suppressWebPush

describe("sendPushToUser — child-session suppression", () => {
    authIt("web-push: suppresses SEND for child session but prunes malformed-keys row", async () => {
        await insertSub("sub-child-1", "user-child-1", "https://example.com/push/child-1");
        await getKysely()
            .updateTable("push_subscription" as any)
            .set({ keys: "not-json" })
            .where("id", "=", "sub-child-1")
            .execute();

        await sendPushToUser("user-child-1", {
            type: "agent_finished",
            title: "Agent finished",
            body: "done",
            sessionId: "sess-child-1",
        }, true);

        // Send suppressed (child session), but malformed keys → row pruned.
        const subs = await getSubscriptionsForUser("user-child-1");
        expect(subs).toHaveLength(0);
    });

    authIt("web-push: delivers (attempts) for a non-child session", async () => {
        await insertSub("sub-child-2", "user-child-2", "https://example.com/push/child-2");
        await getKysely()
            .updateTable("push_subscription" as any)
            .set({ keys: "not-json" })
            .where("id", "=", "sub-child-2")
            .execute();

        await sendPushToUser("user-child-2", {
            type: "agent_finished",
            title: "Agent finished",
            body: "done",
            sessionId: "sess-child-2",
        }, false);

        // Attempted — malformed JSON caused it to be pruned as stale.
        const subs = await getSubscriptionsForUser("user-child-2");
        expect(subs).toHaveLength(0);
    });

    authIt("web-push: suppressWebPush flag also prunes malformed-keys row (no send)", async () => {
        await insertSub("sub-child-3", "user-child-3", "https://example.com/push/child-3", false);
        await getKysely()
            .updateTable("push_subscription" as any)
            .set({ keys: "not-json" })
            .where("id", "=", "sub-child-3")
            .execute();

        // suppressWebPush=true (connected viewer), isChildSession=false
        await sendPushToUser("user-child-3", {
            type: "agent_finished",
            title: "Agent finished",
            body: "done",
            sessionId: "sess-child-3",
        }, false, true);

        // Send suppressed (connected viewer), but malformed keys → row pruned.
        const subs = await getSubscriptionsForUser("user-child-3");
        expect(subs).toHaveLength(0);
    });

    authIt("ntfy: suppresses child sessions by default", async () => {
        await registerNativePush({ userId: "user-child-ntfy-1", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok")); };
        try {
            await sendPushToUser("user-child-ntfy-1", {
                type: "agent_finished",
                title: "Agent finished",
                body: "done",
                sessionId: "sess-child-ntfy-1",
            }, true /* isChildSession */);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        expect(fetchCalled).toBe(false);
    });

    authIt("ntfy: delivers child session when suppressChildNotifications is false", async () => {
        await registerNativePush({ userId: "user-child-ntfy-deliver", platform: "android", suppressChildNotifications: false });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok", { status: 200 })); };
        try {
            await sendPushToUser("user-child-ntfy-deliver", {
                type: "agent_finished",
                title: "Agent finished",
                body: "done",
                sessionId: "sess-child-ntfy-deliver",
            }, true /* isChildSession */);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        expect(fetchCalled).toBe(true);
    });

    authIt("ntfy: still publishes for a non-child session", async () => {
        await registerNativePush({ userId: "user-child-ntfy-2", platform: "android" });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok")); };
        try {
            await sendPushToUser("user-child-ntfy-2", {
                type: "agent_finished",
                title: "Agent finished",
                body: "done",
                sessionId: "sess-child-ntfy-2",
            }, false);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        expect(fetchCalled).toBe(true);
    });

    authIt("ntfy: non-child notification is delivered even when suppressChildNotifications is true", async () => {
        // Regression: the suppressChildNotifications flag must ONLY gate child
        // sessions (isChildSession=true). A top-level session notification must
        // still be published regardless of how the flag is set.
        await registerNativePush({ userId: "user-suppress-nochild", platform: "android", suppressChildNotifications: true });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok", { status: 200 })); };
        try {
            await sendPushToUser("user-suppress-nochild", {
                type: "agent_needs_input",
                title: "Input needed",
                body: "Agent asks a question",
                sessionId: "sess-suppress-nochild",
            }, false /* isChildSession=false → must deliver despite suppressChildNotifications=true */);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        // suppressChildNotifications only suppresses child-session notifications —
        // a top-level session must always be delivered.
        expect(fetchCalled).toBe(true);
    });

    authIt("ntfy: per-registration: suppressed reg skipped, unsuppressed reg delivered", async () => {
        // Two registrations for different users: one suppress=true, one suppress=false.
        // Only the unsuppressed one should receive the child-session notification.
        await registerNativePush({ userId: "user-multi-suppress", platform: "android", suppressChildNotifications: true });
        await registerNativePush({ userId: "user-multi-deliver", platform: "android", suppressChildNotifications: false });
        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";

        let deliverCount = 0;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { deliverCount++; return Promise.resolve(new Response("ok", { status: 200 })); };
        try {
            // isChildSession=true: suppress reg must skip, deliver reg must publish.
            await sendPushToUser("user-multi-suppress", {
                type: "agent_needs_input",
                title: "Input needed",
                body: "child asks",
                sessionId: "sess-multi",
            }, true);
            const afterSuppress = deliverCount;

            await sendPushToUser("user-multi-deliver", {
                type: "agent_needs_input",
                title: "Input needed",
                body: "child asks",
                sessionId: "sess-multi-2",
            }, true);
            const afterDeliver = deliverCount;

            expect(afterSuppress).toBe(0); // suppressed → no fetch
            expect(afterDeliver).toBe(1);  // deliver → one fetch
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
    });
});

// ── updateNativeSuppressChildNotifications ────────────────────────────────────

describe("updateNativeSuppressChildNotifications", () => {
    authIt("persists true and makes sendNtfyToUser skip the registration for child sessions", async () => {
        await registerNativePush({ userId: "user-nscn-1", platform: "android" });
        await updateNativeSuppressChildNotifications("user-nscn-1", "android", true);

        const rows = await getNativeRegistrationsForUser("user-nscn-1");
        expect(rows[0].suppressChildNotifications).toBe(1);

        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok")); };
        try {
            await sendPushToUser("user-nscn-1", { type: "agent_finished", title: "done", body: "x", sessionId: "s" }, true);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        expect(fetchCalled).toBe(false);
    });

    authIt("persists false and makes sendNtfyToUser deliver to the registration for child sessions", async () => {
        await registerNativePush({ userId: "user-nscn-2", platform: "android", suppressChildNotifications: true });
        await updateNativeSuppressChildNotifications("user-nscn-2", "android", false);

        const rows = await getNativeRegistrationsForUser("user-nscn-2");
        expect(rows[0].suppressChildNotifications).toBe(0);

        process.env.PIZZAPI_NTFY_URL = "http://ntfy-test";
        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => { fetchCalled = true; return Promise.resolve(new Response("ok", { status: 200 })); };
        try {
            await sendPushToUser("user-nscn-2", { type: "agent_finished", title: "done", body: "x", sessionId: "s" }, true);
        } finally {
            (globalThis as any).fetch = origFetch;
            delete process.env.PIZZAPI_NTFY_URL;
        }
        expect(fetchCalled).toBe(true);
    });

    authIt("returns 0 when no registration exists", async () => {
        const count = await updateNativeSuppressChildNotifications("user-nscn-none", "android", true);
        expect(count).toBe(0);
    });

    authIt("returns 1 when a registration is updated", async () => {
        await registerNativePush({ userId: "user-nscn-3", platform: "android" });
        const count = await updateNativeSuppressChildNotifications("user-nscn-3", "android", true);
        expect(count).toBe(1);
    });
});
