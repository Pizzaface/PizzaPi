import { describe, expect, test } from "bun:test";
import { parseHubSessionsPayload } from "./hub-sessions";

describe("parseHubSessionsPayload", () => {
  test("returns empty array for invalid payload shapes", () => {
    expect(parseHubSessionsPayload(null)).toEqual([]);
    expect(parseHubSessionsPayload({})).toEqual([]);
    expect(parseHubSessionsPayload({ sessions: "nope" })).toEqual([]);
  });

  test("filters out malformed sessions", () => {
    const result = parseHubSessionsPayload({
      sessions: [
        {
          sessionId: "s-1",
          shareUrl: "http://localhost/session/s-1",
          cwd: "/tmp/project",
          startedAt: "2026-01-01T00:00:00.000Z",
          isActive: true,
        },
        { sessionId: "missing-fields" },
      ],
    });

    expect(result).toEqual([
      {
        sessionId: "s-1",
        shareUrl: "http://localhost/session/s-1",
        cwd: "/tmp/project",
        startedAt: "2026-01-01T00:00:00.000Z",
        isActive: true,
      },
    ]);
  });
});
