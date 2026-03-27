import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const requireSessionMock = mock(async () => ({ userId: "user-1" }));
const getSessionsMock = mock(async () => ([{ sessionId: "live-1" }]));
const listPersistedMock = mock(async () => ([{ sessionId: "persisted-1" }]));

mock.module("../middleware.js", () => ({
  requireSession: requireSessionMock,
}));

mock.module("../ws/sio-registry.js", () => ({
  getSessions: getSessionsMock,
}));

mock.module("../sessions/store.js", () => ({
  listPersistedRelaySessionsForUser: listPersistedMock,
  listPinnedRelaySessionsForUser: mock(async () => []),
  pinRelaySession: mock(async () => true),
  unpinRelaySession: mock(async () => true),
}));

const { handleSessionsRoute, shouldIncludePersistedSessions } = await import("./sessions.js");

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

describe("handleSessionsRoute includePersisted", () => {
  beforeEach(() => {
    requireSessionMock.mockClear();
    getSessionsMock.mockClear();
    listPersistedMock.mockClear();
  });

  it("skips persisted session fetch when includePersisted=0", async () => {
    const url = new URL("http://localhost/api/sessions?includePersisted=0");
    const req = new Request(url, { method: "GET" });

    const res = await handleSessionsRoute(req, url);
    expect(res).toBeInstanceOf(Response);

    const body = await res!.json();
    expect(body).toEqual({ sessions: [{ sessionId: "live-1" }] });

    expect(getSessionsMock).toHaveBeenCalledWith("user-1");
    expect(listPersistedMock).not.toHaveBeenCalled();
  });

  it("includes persisted sessions by default", async () => {
    const url = new URL("http://localhost/api/sessions");
    const req = new Request(url, { method: "GET" });

    const res = await handleSessionsRoute(req, url);
    expect(res).toBeInstanceOf(Response);

    const body = await res!.json();
    expect(body).toEqual({
      sessions: [{ sessionId: "live-1" }],
      persistedSessions: [{ sessionId: "persisted-1" }],
    });

    expect(getSessionsMock).toHaveBeenCalledWith("user-1");
    expect(listPersistedMock).toHaveBeenCalledWith("user-1");
  });
});

afterAll(() => {
  mock.restore();
});
