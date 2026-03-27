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

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { fireTrigger, createTriggerClient } from "./trigger-client.js";
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

/** Capture emitted Socket.IO events. */
function createMockSocket() {
    const emitted: Array<{ event: string; data: unknown }> = [];
    return {
        emitted,
        conn: {
            socket: {
                emit(event: string, data: unknown) {
                    emitted.push({ event, data });
                },
                connected: true,
            },
            token: "test-relay-token",
        } as ReturnType<TriggerClientDeps["getRelaySocket"]>,
    };
}

/** Minimal deps where only HTTP is available (no socket). */
function httpOnlyDeps(overrides: Partial<TriggerClientDeps> = {}): TriggerClientDeps {
    return {
        getRelaySocket: () => null,
        getRelayHttpBaseUrl: () => "http://localhost:7492",
        getApiKey: () => "test-api-key",
        fetch: mockFetch(200, { ok: true, triggerId: "ext_abc123" }),
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
                        json: async () => ({ ok: true, triggerId: "ext_abc123" }),
                    } as Response;
                },
            },
        );

        expect(result.ok).toBe(true);
        expect(result.method).toBe("http");
        expect(result.triggerId).toBe("ext_abc123");

        expect(capturedRequests).toHaveLength(1);
        const req = capturedRequests[0];
        expect(req.url).toBe("http://localhost:7492/api/sessions/session-xyz/trigger");
        expect(req.init.method).toBe("POST");
        const headers = req.init.headers as Record<string, string>;
        expect(headers["x-api-key"]).toBe("test-api-key");
        expect(headers["Content-Type"]).toBe("application/json");
    });

    test("encodes special characters in session ID", async () => {
        const capturedUrls: string[] = [];

        await fireTrigger(
            "session/with spaces&special=chars",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps(),
                fetch: async (url, _init) => {
                    capturedUrls.push(url);
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ ok: true, triggerId: "ext_xyz" }),
                    } as Response;
                },
            },
        );

        expect(capturedUrls[0]).toContain(encodeURIComponent("session/with spaces&special=chars"));
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
                        json: async () => ({ ok: true, triggerId: "ext_xyz" }),
                    } as Response;
                },
            },
        );

        expect(capturedBodies).toHaveLength(1);
        const body = capturedBodies[0] as Record<string, unknown>;
        expect(body.type).toBe("godmother:idea_execute");
        expect(body.payload).toEqual({ ideaId: "idea-123", project: "PizzaPi" });
        expect(body.deliverAs).toBe("followUp");
        expect(body.expectsResponse).toBe(true);
        expect(body.source).toBe("godmother");
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
        expect(body.deliverAs).toBe("steer");
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
                        json: async () => ({ ok: true, triggerId: "ext_xyz" }),
                    } as Response;
                },
            },
        );

        const body = capturedBodies[0] as Record<string, unknown>;
        expect("source" in body).toBe(false);
        expect("summary" in body).toBe(false);
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
                        json: async () => ({ ok: true, triggerId: "ext_x" }),
                    } as Response;
                },
            },
        );

        expect(capturedHeaders[0]["x-api-key"]).toBe("my-secret-key");
    });

    test("skips HTTP and tries Socket.IO when no API key is configured", async () => {
        const { emitted, conn } = createMockSocket();
        let fetchCalled = false;

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => undefined,
                fetch: async () => {
                    fetchCalled = true;
                    return {} as Response;
                },
            },
        );

        expect(fetchCalled).toBe(false);
        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(emitted).toHaveLength(1);
        expect(emitted[0].event).toBe("session_trigger");
    });

    test("skips HTTP and tries Socket.IO when no base URL is configured", async () => {
        const { emitted, conn } = createMockSocket();
        let fetchCalled = false;

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => null,
                getApiKey: () => "api-key",
                fetch: async () => {
                    fetchCalled = true;
                    return {} as Response;
                },
            },
        );

        expect(fetchCalled).toBe(false);
        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(emitted).toHaveLength(1);
    });
});

// ── Error cases ────────────────────────────────────────────────────────────────

describe("fireTrigger — error cases", () => {
    test("returns definitive failure on 401 (no Socket.IO fallback)", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps({
                    getRelaySocket: () => conn,
                    fetch: mockFetch(401, { error: "Unauthorized" }),
                }),
            },
        );

        expect(result.ok).toBe(false);
        expect(result.method).toBe("http");
        expect(result.error).toContain("Authentication failed");
        // No Socket.IO fallback for auth errors
        expect(emitted).toHaveLength(0);
    });

    test("returns definitive failure on 403 (no Socket.IO fallback)", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps({
                    getRelaySocket: () => conn,
                    fetch: mockFetch(403, { error: "Forbidden" }),
                }),
            },
        );

        expect(result.ok).toBe(false);
        expect(result.method).toBe("http");
        expect(result.error).toContain("Authentication failed");
        expect(emitted).toHaveLength(0);
    });

    test("returns definitive failure on 404 (no Socket.IO fallback)", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                ...httpOnlyDeps({
                    getRelaySocket: () => conn,
                    fetch: mockFetch(404, { error: "Session not found or not connected" }),
                }),
            },
        );

        expect(result.ok).toBe(false);
        expect(result.method).toBe("http");
        expect(result.error).toContain("Session not found");
        expect(emitted).toHaveLength(0);
    });

    test("falls back to Socket.IO on network failure", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => "api-key",
                fetch: mockNetworkError("ECONNREFUSED"),
            },
        );

        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(emitted).toHaveLength(1);
        expect(emitted[0].event).toBe("session_trigger");
    });

    test("falls back to Socket.IO on 5xx server error", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-abc",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => "http://localhost:7492",
                getApiKey: () => "api-key",
                fetch: mockFetch(502, { error: "Bad gateway" }),
            },
        );

        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(emitted).toHaveLength(1);
    });

    test("returns failure when both HTTP and Socket.IO are unavailable", async () => {
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
        expect(result.error).toContain("cannot fire trigger");
    });
});

// ── Socket.IO delivery tests ───────────────────────────────────────────────────

describe("fireTrigger — Socket.IO delivery", () => {
    test("emits session_trigger with correct shape", async () => {
        const { emitted, conn } = createMockSocket();

        const result = await fireTrigger(
            "session-xyz",
            {
                type: "godmother:idea_execute",
                payload: { ideaId: "idea-abc", project: "PizzaPi" },
                source: "godmother",
                deliverAs: "steer",
            },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => null,
                getApiKey: () => undefined,
                fetch: async () => { throw new Error("HTTP not available"); },
            },
        );

        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(result.triggerId).toMatch(/^ext_/);

        expect(emitted).toHaveLength(1);
        const { event, data } = emitted[0] as { event: string; data: any };
        expect(event).toBe("session_trigger");
        expect(data.token).toBe("test-relay-token");
        expect(data.trigger.type).toBe("godmother:idea_execute");
        expect(data.trigger.targetSessionId).toBe("session-xyz");
        expect(data.trigger.payload).toEqual({ ideaId: "idea-abc", project: "PizzaPi" });
        expect(data.trigger.sourceSessionId).toBe("external:godmother");
        expect(data.trigger.deliverAs).toBe("steer");
        expect(data.trigger.triggerId).toMatch(/^ext_/);
        expect(typeof data.trigger.ts).toBe("string");
    });

    test("uses trigger-client as default source when source not specified", async () => {
        const { emitted, conn } = createMockSocket();

        await fireTrigger(
            "session-xyz",
            { type: "test", payload: {} },
            {
                getRelaySocket: () => conn,
                getRelayHttpBaseUrl: () => null,
                getApiKey: () => undefined,
                fetch: async () => { throw new Error("not available"); },
            },
        );

        const data = emitted[0].data as any;
        expect(data.trigger.sourceSessionId).toBe("external:trigger-client");
    });
});

// ── createTriggerClient tests ──────────────────────────────────────────────────

describe("createTriggerClient", () => {
    test("returns a bound client that delegates to fireTrigger", async () => {
        const { emitted, conn } = createMockSocket();

        const client = createTriggerClient({
            getRelaySocket: () => conn,
            getRelayHttpBaseUrl: () => null,
            getApiKey: () => undefined,
            fetch: async () => { throw new Error("not available"); },
        });

        const result = await client.fire("session-abc", {
            type: "test:event",
            payload: { data: 42 },
        });

        expect(result.ok).toBe(true);
        expect(result.method).toBe("socketio");
        expect(emitted).toHaveLength(1);
    });

    test("can fire multiple triggers with the same client", async () => {
        const { emitted, conn } = createMockSocket();

        const client = createTriggerClient({
            getRelaySocket: () => conn,
            getRelayHttpBaseUrl: () => null,
            getApiKey: () => undefined,
            fetch: async () => { throw new Error("not available"); },
        });

        await client.fire("session-a", { type: "type-1", payload: { n: 1 } });
        await client.fire("session-b", { type: "type-2", payload: { n: 2 } });

        expect(emitted).toHaveLength(2);
        expect((emitted[0].data as any).trigger.targetSessionId).toBe("session-a");
        expect((emitted[1].data as any).trigger.targetSessionId).toBe("session-b");
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
                    json: async () => ({ ok: true, triggerId: "ext_http_trigger" }),
                } as Response;
            },
        });

        const result = await client.fire("session-abc", {
            type: "service:notify",
            payload: { message: "hello" },
        });

        expect(result.ok).toBe(true);
        expect(result.method).toBe("http");
        expect(result.triggerId).toBe("ext_http_trigger");
        expect(capturedUrls[0]).toBe(
            "https://relay.example.com/api/sessions/session-abc/trigger",
        );
    });
});
