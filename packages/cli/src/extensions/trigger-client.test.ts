// ============================================================================
// trigger-client.test.ts — Unit tests for the trigger HTTP client
//
// Tests cover:
//   - Successful HTTP trigger firing
//   - Auth token (API key) handling in request headers
//   - Socket.IO fallback when HTTP is unavailable
//   - Error cases: network failure, 404 (not found), 401 (unauthorized)
//   - createTriggerClient bound helper
// ============================================================================

import { describe, test, expect } from "bun:test";
import {
    fireTrigger,
    createTriggerClient,
    getAvailableTriggers,
    getAvailableSigils,
    subscribeTrigger,
    listTriggerSubscriptions,
    unsubscribeTrigger,
    updateTriggerSubscription,
    publishEvent,
} from "./trigger-client.js";
import type { TriggerClientDeps } from "./trigger-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock fetch that returns a canned response. */
function mockFetch(status: number, body: unknown): TriggerClientDeps["fetch"] {
    return async (_url: string, _init?: RequestInit) => {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => JSON.stringify(body),
        } as Response;
    };
}

/** Build a mock fetch that throws a network error. */
function mockNetworkError(message = "fetch failed"): TriggerClientDeps["fetch"] {
    return async (_url: string, _init?: RequestInit) => {
        throw new Error(message);
    };
}

/** Minimal deps where only HTTP is available (no socket). */
function httpOnlyDeps(overrides: Partial<TriggerClientDeps> = {}): TriggerClientDeps {
    return {
        getRelaySocket: () => null,
        getRelayHttpBaseUrl: () => "http://localhost:7492",
        getApiKey: () => "test-api-key",
        fetch: mockFetch(200, { ok: true, eventId: "evt_abc123", created: true, deliveries: [] }),
        ...overrides,
    };
}

// ── HTTP delivery tests ────────────────────────────────────────────────────────

describe("fireTrigger — HTTP delivery", () => {
    test("fires trigger via HTTP with correct URL and headers", async () => {
        const capturedRequests: Array<{ url: string; init: RequestInit }> = [];

        const result = await fireTrigger(
            "session-xyz",
            { type: "test:event", payload: { key: "value" } },
            {
                ...httpOnlyDeps(),
                fetch: async (url, init) => {
                    capturedRequests.push({ url, init: init ?? {} });
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, eventId: "evt_abc123", created: true, deliveries: [] }),
                    } as Response;
                },
            },
        );

        expect(result.ok).toBe(true);
        expect(result.eventId).toBe("evt_abc123");

        expect(capturedRequests).toHaveLength(1);
        const req = capturedRequests[0];
        expect(req.url).toBe("http://localhost:7492/api/events");
        expect(req.init.method).toBe("POST");
        const headers = req.init.headers as Record<string, string>;
        expect(headers["x-api-key"]).toBe("test-api-key");
        expect(headers["Content-Type"]).toBe("application/json");
    });

    test("targets the session via the publish body target", async () => {
        const capturedBodies: unknown[] = [];

        await fireTrigger(
            "session/with spaces&special=chars",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps(),
                fetch: async (_url, init) => {
                    capturedBodies.push(JSON.parse(init?.body as string));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, eventId: "evt_xyz", created: true, deliveries: [] }),
                    } as Response;
                },
            },
        );

        expect((capturedBodies[0] as any).target.sessionId).toBe("session/with spaces&special=chars");
    });

    test("sends correct payload body", async () => {
        const capturedBodies: unknown[] = [];

        await fireTrigger(
            "session-abc",
            {
                type: "godmother:idea_execute",
                payload: { ideaId: "idea-123", project: "PizzaPi" },
                deliverAs: "followUp",
                expectsResponse: true,
                source: "godmother",
                summary: "Idea moved to execute",
            },
            {
                ...httpOnlyDeps(),
                fetch: async (_url, init) => {
                    capturedBodies.push(JSON.parse(init?.body as string));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, eventId: "evt_xyz", created: true, deliveries: [] }),
                    } as Response;
                },
            },
        );

        expect(capturedBodies).toHaveLength(1);
        const body = capturedBodies[0] as Record<string, unknown>;
        expect(body.type).toBe("godmother:idea_execute");
        expect(body.payload).toEqual({ ideaId: "idea-123", project: "PizzaPi" });
        expect(body.target).toEqual({ sessionId: "session-abc", deliverAs: "followUp" });
        expect(body.responseContract).toEqual({ escalate: true, ttlMs: 30 * 60 * 1000 });
        expect(body.source).toEqual({ id: "godmother", name: "godmother" });
        expect(body.summary).toBe("Idea moved to execute");
    });

    test("defaults deliverAs to 'steer' when not specified", async () => {
        const capturedBodies: unknown[] = [];

        await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps(),
                fetch: async (_url, init) => {
                    capturedBodies.push(JSON.parse(init?.body as string));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, triggerId: "ext_xyz" }),
                    } as Response;
                },
            },
        );

        const body = capturedBodies[0] as Record<string, unknown>;
        expect((body.target as Record<string, unknown>).deliverAs).toBe("steer");
    });

    test("does not include undefined optional fields in body", async () => {
        const capturedBodies: unknown[] = [];

        await fireTrigger(
            "session-abc",
            { type: "test", payload: { x: 1 } },
            {
                ...httpOnlyDeps(),
                fetch: async (_url, init) => {
                    capturedBodies.push(JSON.parse(init?.body as string));
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, eventId: "evt_xyz", created: true, deliveries: [] }),
                    } as Response;
                },
            },
        );

        const body = capturedBodies[0] as Record<string, unknown>;
        expect("source" in body).toBe(false);
        expect("summary" in body).toBe(false);
        expect("responseContract" in body).toBe(false);
    });
});

// ── Auth token tests ───────────────────────────────────────────────────────────

describe("fireTrigger — auth token handling", () => {
    test("sends API key from getApiKey in x-api-key header", async () => {
        const capturedHeaders: Record<string, string>[] = [];

        await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps({ getApiKey: () => "my-secret-key" }),
                fetch: async (_url, init) => {
                    capturedHeaders.push(init?.headers as Record<string, string>);
                    return {
                        ok: true, status: 200,
                        json: async () => ({ ok: true, eventId: "evt_x", created: true, deliveries: [] }),
                    } as Response;
                },
            },
        );

        expect(capturedHeaders[0]["x-api-key"]).toBe("my-secret-key");
    });

    test("returns a requires-relay error when no API key is configured (no fallback)", async () => {
        let fetchCalled = false;

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => null,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => undefined,
                fetch: async () => {
                    fetchCalled = true;
                    return {} as Response;
                },
            },
        );

        expect(fetchCalled).toBe(false);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("requires a relay");
    });

    test("returns a requires-relay error when no base URL is configured (no fallback)", async () => {
        let fetchCalled = false;

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => null,
                getRelayHttpBaseUrl: () => null,
                getApiKey: () => "api-key",
                fetch: async () => {
                    fetchCalled = true;
                    return {} as Response;
                },
            },
        );

        expect(fetchCalled).toBe(false);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("requires a relay");
    });
});

// ── Error cases ────────────────────────────────────────────────────────────────

describe("fireTrigger — error cases", () => {
    test("returns definitive failure on 401", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            { ...httpOnlyDeps({ fetch: mockFetch(401, { error: "Unauthorized" }) }) },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Unauthorized");
    });

    test("returns definitive failure on 403", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            { ...httpOnlyDeps({ fetch: mockFetch(403, { error: "Forbidden" }) }) },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Forbidden");
    });

    test("returns definitive failure on 404", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            { ...httpOnlyDeps({ fetch: mockFetch(404, { error: "Session not found or not connected" }) }) },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Session not found");
    });

    test("returns failure on network error (no fallback)", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => null,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => "api-key",
                fetch: mockNetworkError("ECONNREFUSED"),
            },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("ECONNREFUSED");
    });

    test("returns failure on 5xx server error (no fallback)", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => null,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => "api-key",
                fetch: mockFetch(502, { error: "Bad gateway" }),
            },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("Bad gateway");
    });

    test("returns failure when no relay is configured at all", async () => {
        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => null,
                getRelayHttpBaseUrl: () => null,
                getApiKey: () => undefined,
                fetch: async () => { throw new Error("should not be called"); },
            },
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("requires a relay");
    });
});

describe("publishEvent — HTTP status", () => {
    test("exposes the HTTP status on a failed publish", async () => {
        const result = await publishEvent(
            { type: "test:event", payload: {} },
            httpOnlyDeps({ fetch: mockFetch(404, { error: "Parent session not found" }) }),
        );

        expect(result).toEqual({
            ok: false,
            error: "Parent session not found",
            status: 404,
        });
    });

    test("leaves status absent for network failures", async () => {
        const result = await publishEvent(
            { type: "test:event", payload: {} },
            httpOnlyDeps({ fetch: mockNetworkError("ECONNRESET") }),
        );

        expect(result.ok).toBe(false);
        expect(result.error).toContain("ECONNRESET");
        expect(result.status).toBeUndefined();
    });
});

// ── createTriggerClient tests ──────────────────────────────────────────────────

describe("createTriggerClient", () => {
    test("returns a bound client that delegates to fireTrigger", async () => {
        const client = createTriggerClient({
            getRelaySocket: () => null,
            getRelayHttpBaseUrl: () => "http://localhost:7492",
            getApiKey: () => "test-api-key",
            fetch: mockFetch(200, { ok: true, eventId: "evt_1", created: true, deliveries: [] }),
        });

        const result = await client.fire("session-abc", {
            type: "test:event",
            payload: { data: 42 },
        });

        expect(result.ok).toBe(true);
        expect(result.eventId).toBe("evt_1");
    });

    test("can fire multiple triggers with the same client", async () => {
        const capturedBodies: any[] = [];

        const client = createTriggerClient({
            getRelaySocket: () => null,
            getRelayHttpBaseUrl: () => "http://localhost:7492",
            getApiKey: () => "test-api-key",
            fetch: async (_url, init) => {
                capturedBodies.push(JSON.parse(init?.body as string));
                return {
                    ok: true, status: 200,
                    json: async () => ({ ok: true, eventId: "evt_x", created: true, deliveries: [] }),
                } as Response;
            },
        });

        await client.fire("session-a", { type: "type-1", payload: { n: 1 } });
        await client.fire("session-b", { type: "type-2", payload: { n: 2 } });

        expect(capturedBodies).toHaveLength(2);
        expect(capturedBodies[0].target.sessionId).toBe("session-a");
        expect(capturedBodies[1].target.sessionId).toBe("session-b");
    });

    test("HTTP client fires via HTTP when configured", async () => {
        const capturedUrls: string[] = [];

        const client = createTriggerClient({
            getRelaySocket: () => null,
            getRelayHttpBaseUrl: () => "https://relay.example.com",
            getApiKey: () => "my-api-key",
            fetch: async (url, _init) => {
                capturedUrls.push(url);
                return {
                    ok: true, status: 200,
                    json: async () => ({ ok: true, eventId: "evt_http_trigger", created: true, deliveries: [] }),
                } as Response;
            },
        });

        const result = await client.fire("session-abc", {
            type: "service:notify",
            payload: { message: "hello" },
        });

        expect(result.ok).toBe(true);
        expect(result.eventId).toBe("evt_http_trigger");
        expect(capturedUrls[0]).toBe("https://relay.example.com/api/events");
    });
});

// ── Subscription helpers ──────────────────────────────────────────────────────

/** Build minimal deps for subscription tests. */
function subsDeps(fetchImpl: TriggerClientDeps["fetch"]): TriggerClientDeps {
    return {
        getRelaySocket: () => null,
        getRelayHttpBaseUrl: () => "http://localhost:7492",
        getApiKey: () => "test-api-key",
        fetch: fetchImpl,
    };
}

describe("getAvailableTriggers", () => {
    test("returns trigger defs from the runner", async () => {
        const deps = subsDeps(async (_url, _init) => ({
            ok: true,
            status: 200,
            json: async () => ({
                triggerDefs: [
                    { type: "godmother:idea_moved", label: "Idea Moved" },
                    { type: "godmother:idea_created", label: "Idea Created" },
                ],
            }),
        } as Response));

        const defs = await getAvailableTriggers("session-1", deps);
        expect(defs).toHaveLength(2);
        expect(defs[0].type).toBe("godmother:idea_moved");
        expect(defs[1].label).toBe("Idea Created");
    });

    test("returns empty array when response is not ok", async () => {
        const deps = subsDeps(async () => ({ ok: false, status: 404, json: async () => ({}) } as Response));
        const defs = await getAvailableTriggers("session-1", deps);
        expect(defs).toEqual([]);
    });

    test("returns empty array when no base URL configured", async () => {
        const deps: TriggerClientDeps = {
            getRelaySocket: () => null,
            getRelayHttpBaseUrl: () => null,
            getApiKey: () => "key",
            fetch: async () => { throw new Error("should not be called"); },
        };
        const defs = await getAvailableTriggers("session-1", deps);
        expect(defs).toEqual([]);
    });

    test("sends request to correct endpoint with API key", async () => {
        const captured: Array<{ url: string; headers: Record<string, string> }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
            return { ok: true, status: 200, json: async () => ({ triggerDefs: [] }) } as Response;
        });

        await getAvailableTriggers("session-abc", deps);
        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe("http://localhost:7492/api/sessions/session-abc/available-triggers");
        expect(captured[0].headers["x-api-key"]).toBe("test-api-key");
    });
});

describe("getAvailableSigils", () => {
    test("returns sigil defs from the runner", async () => {
        const deps = subsDeps(async (_url, _init) => ({
            ok: true,
            status: 200,
            json: async () => ({
                sigilDefs: [
                    { type: "pr", label: "Pull Request", aliases: ["mr"] },
                    { type: "commit", label: "Commit" },
                ],
            }),
        } as Response));

        const defs = await getAvailableSigils("session-1", deps);
        expect(defs).toHaveLength(2);
        expect(defs[0].type).toBe("pr");
        expect(defs[0].aliases).toEqual(["mr"]);
        expect(defs[1].label).toBe("Commit");
    });

    test("returns empty array when response is not ok", async () => {
        const deps = subsDeps(async () => ({ ok: false, status: 404, json: async () => ({}) } as Response));
        const defs = await getAvailableSigils("session-1", deps);
        expect(defs).toEqual([]);
    });

    test("sends request to correct endpoint with API key", async () => {
        const captured: Array<{ url: string; headers: Record<string, string> }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
            return { ok: true, status: 200, json: async () => ({ sigilDefs: [] }) } as Response;
        });

        await getAvailableSigils("session-abc", deps);
        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe("http://localhost:7492/api/sessions/session-abc/available-sigils");
        expect(captured[0].headers["x-api-key"]).toBe("test-api-key");
    });
});

describe("subscribeTrigger (unified routes)", () => {
    test("creates a session-target route and returns the routeId as subscriptionId", async () => {
        const captured: Array<{ url: string; method: string; body: any }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET", body: JSON.parse(init?.body as string ?? "{}") });
            return { ok: true, status: 200, json: async () => ({ ok: true, route: { routeId: "rt-1", eventType: "godmother:idea_moved" } }) } as Response;
        });

        const result = await subscribeTrigger("session-1", "godmother:idea_moved", deps, { repo: "acme/app" });
        expect(result.ok).toBe(true);
        expect(result.subscriptionId).toBe("rt-1");
        expect(result.triggerType).toBe("godmother:idea_moved");

        expect(captured[0].url).toBe("http://localhost:7492/api/routes");
        expect(captured[0].method).toBe("POST");
        expect(captured[0].body).toEqual({
            eventType: "godmother:idea_moved",
            target: { kind: "session", sessionId: "session-1" },
            deliverAs: "followUp",
            origin: "agent",
            params: { repo: "acme/app" },
        });
    });

    test("returns error when server rejects the route", async () => {
        const deps = subsDeps(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: "Route requires deliverAs" }),
        } as Response));

        const result = await subscribeTrigger("session-1", "bad:type", deps);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("deliverAs");
    });

    test("returns error when no base URL configured", async () => {
        const deps: TriggerClientDeps = {
            getRelaySocket: () => null,
            getRelayHttpBaseUrl: () => null,
            getApiKey: () => "key",
            fetch: async () => { throw new Error("should not be called"); },
        };
        const result = await subscribeTrigger("session-1", "svc:event", deps);
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

describe("listTriggerSubscriptions (unified routes)", () => {
    test("lists session-target routes as subscriptions, filtering other sessions", async () => {
        const deps = subsDeps(async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                routes: [
                    { routeId: "rt-1", eventType: "godmother:idea_moved", target: { kind: "session", sessionId: "session-1" } },
                    { routeId: "rt-2", eventType: "time:timer_fired", target: { kind: "session", sessionId: "session-1" } },
                    { routeId: "rt-3", eventType: "godmother:idea_moved", target: { kind: "session", sessionId: "other-session" } },
                    { routeId: "rt-4", eventType: "t:spawn", target: { kind: "spawn", spec: { runnerId: "r" } } },
                ],
            }),
        } as Response));

        const subs = await listTriggerSubscriptions("session-1", deps);
        expect(subs).toHaveLength(2);
        expect(subs[0]).toEqual({ subscriptionId: "rt-1", triggerType: "godmother:idea_moved", runnerId: "" });
        expect(subs[1]).toEqual({ subscriptionId: "rt-2", triggerType: "time:timer_fired", runnerId: "" });
    });

    test("returns empty array when not ok", async () => {
        const deps = subsDeps(async () => ({ ok: false, status: 401, json: async () => ({}) } as Response));
        const subs = await listTriggerSubscriptions("session-1", deps);
        expect(subs).toEqual([]);
    });
});

describe("unsubscribeTrigger (unified routes)", () => {
    test("deletes by subscription id (routeId)", async () => {
        const captured: Array<{ url: string; method: string }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET" });
            return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });

        const result = await unsubscribeTrigger("session-1", { subscriptionId: "rt-1" }, deps);
        expect(result.ok).toBe(true);
        expect(result.subscriptionId).toBe("rt-1");
        expect(captured).toEqual([
            { url: "http://localhost:7492/api/routes/rt-1", method: "DELETE" },
        ]);
    });

    test("trigger-type-only bulk unsubscribe lists routes then deletes each", async () => {
        const captured: Array<{ url: string; method: string }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET" });
            if (url.endsWith("/api/routes")) {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        routes: [
                            { routeId: "rt-1", eventType: "godmother:idea_moved", target: { kind: "session", sessionId: "session-1" } },
                            { routeId: "rt-2", eventType: "godmother:idea_moved", target: { kind: "session", sessionId: "session-1" } },
                            { routeId: "rt-3", eventType: "other:type", target: { kind: "session", sessionId: "session-1" } },
                        ],
                    }),
                } as Response;
            }
            return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });

        const result = await unsubscribeTrigger("session-1", { triggerType: "godmother:idea_moved" }, deps);
        expect(result.ok).toBe(true);
        expect(captured[0]).toEqual({ url: "http://localhost:7492/api/routes", method: "GET" });
        expect(captured.slice(1)).toEqual([
            { url: "http://localhost:7492/api/routes/rt-1", method: "DELETE" },
            { url: "http://localhost:7492/api/routes/rt-2", method: "DELETE" },
        ]);
    });

    test("nothing found is idempotent success", async () => {
        const deps = subsDeps(async () => ({
            ok: true, status: 200,
            json: async () => ({ routes: [] }),
        } as Response));

        const result = await unsubscribeTrigger("session-1", { triggerType: "svc:event" }, deps);
        expect(result.ok).toBe(true);
    });

    test("returns error when the delete fails", async () => {
        const captured: Array<{ url: string; method: string }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET" });
            return { ok: false, status: 403, json: async () => ({ error: "Config routes are read-only" }) } as Response;
        });

        const result = await unsubscribeTrigger("session-1", { subscriptionId: "rt-cfg" }, deps);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("read-only");
    });
});

describe("updateTriggerSubscription (unified routes)", () => {
    test("updates params by subscription id", async () => {
        const captured: Array<{ url: string; method: string; body: any }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET", body: JSON.parse(init?.body as string ?? "{}") });
            return { ok: true, status: 200, json: async () => ({ ok: true, route: { routeId: "rt-1" } }) } as Response;
        });

        const result = await updateTriggerSubscription("session-1", { subscriptionId: "rt-1" }, { params: { repo: "new/repo" } }, deps);
        expect(result.ok).toBe(true);
        expect(result.subscriptionId).toBe("rt-1");
        expect(captured).toEqual([
            { url: "http://localhost:7492/api/routes/rt-1", method: "PUT", body: { params: { repo: "new/repo" } } },
        ]);
    });

    test("trigger-type-only bulk update lists routes then updates each", async () => {
        const captured: Array<{ url: string; method: string }> = [];
        const deps = subsDeps(async (url, init) => {
            captured.push({ url, method: init?.method ?? "GET" });
            if (url.endsWith("/api/routes")) {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        routes: [
                            { routeId: "rt-1", eventType: "github:pr_comment", target: { kind: "session", sessionId: "session-1" } },
                            { routeId: "rt-2", eventType: "other:type", target: { kind: "session", sessionId: "session-1" } },
                        ],
                    }),
                } as Response;
            }
            return { ok: true, status: 200, json: async () => ({ ok: true, route: { routeId: "rt-1" } }) } as Response;
        });

        const result = await updateTriggerSubscription(
            "session-1",
            { triggerType: "github:pr_comment" },
            { params: { repo: "acme/app" } },
            deps,
        );
        expect(result.ok).toBe(true);
        expect(captured[0]).toEqual({ url: "http://localhost:7492/api/routes", method: "GET" });
        expect(captured[1]).toEqual({ url: "http://localhost:7492/api/routes/rt-1", method: "PUT" });
        expect(captured).toHaveLength(2);
    });

    test("no matching route is an error", async () => {
        const deps = subsDeps(async () => ({
            ok: true, status: 200,
            json: async () => ({ routes: [] }),
        } as Response));

        const result = await updateTriggerSubscription("session-1", { triggerType: "svc:event" }, { params: { a: 1 } }, deps);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("No route found");
    });
});


