import { describe, expect, it, mock, beforeEach } from "bun:test";
import { shouldIncludePersistedSessions } from "./sessions.js";

describe("shouldIncludePersistedSessions", () => {
  it("defaults to true", () => {
    expect(shouldIncludePersistedSessions(undefined)).toBe(true);
    expect(shouldIncludePersistedSessions(null)).toBe(true);
    expect(shouldIncludePersistedSessions("")).toBe(true);
  });

  it("treats 0/false/no as false", () => {
    expect(shouldIncludePersistedSessions("0")).toBe(false);
    expect(shouldIncludePersistedSessions("false")).toBe(false);
    expect(shouldIncludePersistedSessions("no")).toBe(false);
    expect(shouldIncludePersistedSessions(" FALSE ")).toBe(false);
  });
});

// ── Route-level tests ─────────────────────────────────────────────────────────
//
// These tests exercise handleSessionsRoute directly with mocked dependencies so
// the fast path (includePersisted=0), the full path, auth failures, and
// response shapes are all covered at the API boundary.

const mockGetSessions = mock(async (_userId: string) => [] as any[]);
const mockListPersistedRelaySessionsForUser = mock(async (_userId: string) => [] as any[]);

// requireSession: typed to match the actual return signature (identity or 401 Response)
const mockRequireSession = mock(
    async (_req: Request): Promise<{ userId: string; userName: string } | Response> => ({
        userId: "user-123",
        userName: "Test User",
    })
);

mock.module("../ws/sio-registry.js", () => ({
    getSessions: mockGetSessions,
}));

mock.module("../sessions/store.js", () => ({
    listPersistedRelaySessionsForUser: mockListPersistedRelaySessionsForUser,
    listPinnedRelaySessionsForUser: mock(async () => []),
    pinRelaySession: mock(async () => {}),
    unpinRelaySession: mock(async () => {}),
}));

mock.module("../middleware.js", () => ({
    requireSession: mockRequireSession,
}));

import { handleSessionsRoute } from "./sessions.js";

function makeRequest(path: string, method = "GET"): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, { method });
    return [req, url];
}

describe("handleSessionsRoute — GET /api/sessions", () => {
    beforeEach(() => {
        mockGetSessions.mockReset();
        mockListPersistedRelaySessionsForUser.mockReset();
        mockRequireSession.mockReset();

        // Restore defaults
        mockGetSessions.mockImplementation(async () => []);
        mockListPersistedRelaySessionsForUser.mockImplementation(async () => []);
        mockRequireSession.mockImplementation(async () => ({
            userId: "user-123",
            userName: "Test User",
        }));
    });

    it("returns 401 when not authenticated", async () => {
        mockRequireSession.mockImplementation(async () =>
            Response.json({ error: "Unauthorized" }, { status: 401 })
        );

        const [req, url] = makeRequest("/api/sessions");
        const res = await handleSessionsRoute(req, url);
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(401);
    });

    it("returns sessions and persistedSessions on the default (full) path", async () => {
        const fakeSessions = [{ id: "s1", name: "Session 1" }];
        const fakePersisted = [{ id: "p1", name: "Persisted 1" }];
        mockGetSessions.mockImplementation(async () => fakeSessions);
        mockListPersistedRelaySessionsForUser.mockImplementation(async () => fakePersisted);

        const [req, url] = makeRequest("/api/sessions");
        const res = await handleSessionsRoute(req, url);
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(200);

        const body = await res!.json();
        expect(body.sessions).toEqual(fakeSessions);
        expect(body.persistedSessions).toEqual(fakePersisted);
    });

    it("fast path (includePersisted=0): skips persisted lookup and returns persistedSessions:[]", async () => {
        const fakeSessions = [{ id: "s2", name: "Session 2" }];
        mockGetSessions.mockImplementation(async () => fakeSessions);

        const [req, url] = makeRequest("/api/sessions?includePersisted=0");
        const res = await handleSessionsRoute(req, url);
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(200);

        // Must NOT have called the persisted lookup
        expect(mockListPersistedRelaySessionsForUser).not.toHaveBeenCalled();

        const body = await res!.json();
        expect(body.sessions).toEqual(fakeSessions);
        // Response shape must include persistedSessions for API contract compat
        expect(body.persistedSessions).toEqual([]);
    });

    it("fast path (includePersisted=false): also skips persisted lookup", async () => {
        mockGetSessions.mockImplementation(async () => []);

        const [req, url] = makeRequest("/api/sessions?includePersisted=false");
        const res = await handleSessionsRoute(req, url);
        expect(res!.status).toBe(200);
        expect(mockListPersistedRelaySessionsForUser).not.toHaveBeenCalled();

        const body = await res!.json();
        expect(body).toHaveProperty("persistedSessions");
        expect(body.persistedSessions).toEqual([]);
    });

    it("full path fetches sessions and persistedSessions in parallel", async () => {
        const calls: string[] = [];
        mockGetSessions.mockImplementation(async () => { calls.push("sessions"); return []; });
        mockListPersistedRelaySessionsForUser.mockImplementation(async () => {
            calls.push("persisted");
            return [];
        });

        const [req, url] = makeRequest("/api/sessions");
        await handleSessionsRoute(req, url);

        expect(calls).toContain("sessions");
        expect(calls).toContain("persisted");
    });

    it("returns undefined for unrecognised routes", async () => {
        const [req, url] = makeRequest("/api/sessions/unknown-path/xyz");
        const res = await handleSessionsRoute(req, url);
        expect(res).toBeUndefined();
    });
});
