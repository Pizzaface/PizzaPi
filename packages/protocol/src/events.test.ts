import { describe, expect, test } from "bun:test";
import {
  isDeliveryStatus,
  isRouteTarget,
  isSourceIdentity,
  routeMatchesOwner,
  isTriggerEvent,
  isValidEventType,
  renderEventText,
  type TriggerEvent,
} from "./events.js";

const source = { kind: "service", id: "github", name: "GitHub", auth: "socket" } as const;

const event: TriggerEvent = {
  eventId: "evt_1",
  type: "github:pr_comment",
  source,
  payload: { pr: 123, author: "alice", body: "LGTM", meta: { repo: "pizzapi" } },
  summary: "PR comment",
  ts: "2026-08-30T00:00:00Z",
};

describe("isValidEventType", () => {
  test("accepts namespaced types", () => {
    expect(isValidEventType("lifecycle:session_complete")).toBe(true);
    expect(isValidEventType("github:pr_comment")).toBe(true);
    expect(isValidEventType("time:cron")).toBe(true);
    expect(isValidEventType("schedule:nightly.2am")).toBe(true);
  });

  test("rejects un-namespaced, uppercase, and malformed types", () => {
    expect(isValidEventType("session_complete")).toBe(false);
    expect(isValidEventType("GitHub:pr")).toBe(false);
    expect(isValidEventType(":x")).toBe(false);
    expect(isValidEventType("a:")).toBe(false);
    expect(isValidEventType(42)).toBe(false);
  });
});

describe("guards", () => {
  test("isSourceIdentity", () => {
    expect(isSourceIdentity(source)).toBe(true);
    expect(isSourceIdentity({ ...source, kind: "alien" })).toBe(false);
    expect(isSourceIdentity({ ...source, id: "" })).toBe(false);
    expect(isSourceIdentity(null)).toBe(false);
  });

  test("isTriggerEvent", () => {
    expect(isTriggerEvent(event)).toBe(true);
    expect(isTriggerEvent({ ...event, type: "notNamespaced" })).toBe(false);
    expect(isTriggerEvent({ ...event, payload: "nope" })).toBe(false);
    expect(isTriggerEvent({ ...event, source: {} })).toBe(false);
  });

  test("isRouteTarget accepts well-formed session and spawn targets", () => {
    expect(isRouteTarget({ kind: "session", sessionId: "s1" })).toBe(true);
    expect(isRouteTarget({ kind: "session", sessionId: "s1", runnerId: "runner-1", wake: true })).toBe(true);
    expect(isRouteTarget({
      kind: "spawn",
      spec: {
        runnerId: "runner-1",
        cwd: "/tmp",
        model: { provider: "anthropic", id: "claude" },
        promptTemplate: "Handle this",
        autoClose: true,
        ownerUserId: "user-1",
      },
    })).toBe(true);
  });

  test("isRouteTarget rejects malformed session targets", () => {
    expect(isRouteTarget({ kind: "session", sessionId: "" })).toBe(false);
    expect(isRouteTarget({ kind: "session", sessionId: 1 })).toBe(false);
    expect(isRouteTarget({ kind: "session", sessionId: "s1", runnerId: 1 })).toBe(false);
    expect(isRouteTarget({ kind: "session", sessionId: "s1", wake: "yes" })).toBe(false);
  });

  test("isRouteTarget rejects malformed spawn targets", () => {
    const invalid = [
      { kind: "spawn" },
      { kind: "spawn", spec: null },
      { kind: "spawn", spec: {} },
      { kind: "spawn", spec: { runnerId: "" } },
      { kind: "spawn", spec: { runnerId: 1 } },
      { kind: "spawn", spec: { runnerId: "r1", cwd: 1 } },
      { kind: "spawn", spec: { runnerId: "r1", model: null } },
      { kind: "spawn", spec: { runnerId: "r1", model: { provider: "p" } } },
      { kind: "spawn", spec: { runnerId: "r1", model: { provider: 1, id: "m" } } },
      { kind: "spawn", spec: { runnerId: "r1", promptTemplate: false } },
      { kind: "spawn", spec: { runnerId: "r1", autoClose: "yes" } },
      { kind: "spawn", spec: { runnerId: "r1", ownerUserId: 1 } },
    ];
    for (const target of invalid) expect(isRouteTarget(target)).toBe(false);
    expect(isRouteTarget({ kind: "broadcast" })).toBe(false);
  });

  test("isDeliveryStatus", () => {
    expect(isDeliveryStatus("pending")).toBe(true);
    expect(isDeliveryStatus("inflight")).toBe(true);
    expect(isDeliveryStatus("delivered")).toBe(true);
    expect(isDeliveryStatus("responded")).toBe(true);
    expect(isDeliveryStatus("done")).toBe(false);
  });
});

describe("renderEventText", () => {
  test("fallback includes summary, type, source, and payload", () => {
    const text = renderEventText(event);
    expect(text).toContain("PR comment");
    expect(text).toContain("github:pr_comment");
    expect(text).toContain("service:github");
    expect(text).toContain('"author": "alice"');
  });

  test("type template resolves placeholders including dotted paths", () => {
    const text = renderEventText(event, { template: "PR #{{pr}} by {{author}} in {{meta.repo}}: {{body}}" });
    expect(text).toBe("PR #123 by alice in pizzapi: LGTM");
  });

  test("route promptTemplate overrides type template; missing fields render empty", () => {
    const text = renderEventText(event, { template: "type-level" }, { promptTemplate: "route says {{body}}{{missing}}" });
    expect(text).toBe("route says LGTM");
  });
});

describe("routeMatchesOwner", () => {
  test("owned routes match only their owner's events", () => {
    expect(routeMatchesOwner({ origin: "ui", ownerUserId: "a" }, "a")).toBe(true);
    expect(routeMatchesOwner({ origin: "ui", ownerUserId: "a" }, "b")).toBe(false);
    expect(routeMatchesOwner({ origin: "ui", ownerUserId: "a" }, undefined)).toBe(false);
  });
  test("ownerless config routes are operator-level; ownerless others match nothing", () => {
    expect(routeMatchesOwner({ origin: "config" }, "a")).toBe(true);
    expect(routeMatchesOwner({ origin: "config" }, undefined)).toBe(true);
    expect(routeMatchesOwner({ origin: "config", ownerUserId: "a" }, "b")).toBe(false);
    expect(routeMatchesOwner({ origin: "agent" }, "a")).toBe(false);
  });
});
