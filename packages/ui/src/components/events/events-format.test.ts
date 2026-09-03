import { describe, expect, test } from "bun:test";
import type { Delivery, Route, RouteTarget, ServiceTriggerParamDef, SourceIdentity, TriggerEvent } from "@pizzapi/protocol";
import {
  canRespond,
  formatParamValue,
  parseFilterValue,
  parseParamInput,
  DELIVERY_STATUS_META,
  eventSourceLabel,
  eventTitle,
  isReadOnlyRoute,
  isRespondableDelivery,
  summarizeRouteTarget,
  timeAgo,
} from "./events-format.js";

const sessionTarget = (sessionId: string, wake = false): RouteTarget =>
  wake ? { kind: "session", sessionId, wake: true } : { kind: "session", sessionId };

const route = (origin: Route["origin"]): Route => ({
  routeId: "rt_1",
  eventType: "github:pr_comment",
  target: sessionTarget("a1b2c3d4-e5f6-7890-abcd-ef0123456789"),
  deliverAs: "steer",
  origin,
  createdAt: "2026-01-01T00:00:00Z",
});

const delivery = (status: Delivery["status"]): Delivery => ({
  deliveryId: "dlv_1",
  eventId: "evt_1",
  eventType: "lifecycle:plan_review",
  sessionId: "s-1",
  deliverAs: "steer",
  status,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("summarizeRouteTarget", () => {
  test("session targets show a short id and wake marker", () => {
    expect(summarizeRouteTarget(sessionTarget("a1b2c3d4-e5f6-7890-abcd-ef0123456789"))).toBe("Session a1b2c3d4");
    expect(summarizeRouteTarget(sessionTarget("a1b2c3d4-e5f6-7890-abcd-ef0123456789", true))).toBe("Session a1b2c3d4 · wake");
  });

  test("spawn targets include runner, cwd, model, auto-close", () => {
    expect(summarizeRouteTarget({ kind: "spawn", spec: { runnerId: "runner-xyzw" } })).toBe("Spawn on runner-x");
    expect(
      summarizeRouteTarget({
        kind: "spawn",
        spec: { runnerId: "runner-xyzw", cwd: "/repo", model: { provider: "anthropic", id: "claude-haiku-4-5" }, autoClose: true },
      }),
    ).toBe("Spawn on runner-x · cwd /repo · anthropic/claude-haiku-4-5 · auto-close");
  });
});

describe("route read-only + status meta", () => {
  test("config routes are read-only", () => {
    expect(isReadOnlyRoute(route("config"))).toBe(true);
    expect(isReadOnlyRoute(route("agent"))).toBe(false);
    expect(isReadOnlyRoute(route("ui"))).toBe(false);
  });

  test("every delivery status has chip metadata", () => {
    for (const status of ["pending", "delivered", "responded", "escalated", "expired"] as const) {
      expect(DELIVERY_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(DELIVERY_STATUS_META[status].className.length).toBeGreaterThan(0);
    }
  });
});

describe("feed helpers", () => {
  const source: SourceIdentity = { kind: "session", id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789", auth: "socket" };
  test("source labels are compact", () => {
    expect(eventSourceLabel(source)).toBe("session:a1b2c3d4");
    expect(eventSourceLabel({ kind: "webhook", id: "wh-1", auth: "hmac" })).toBe("webhook:wh-1");
  });

  test("event title prefers summary", () => {
    const event = { eventId: "e", type: "github:pr_comment", source, payload: {}, ts: "" } as TriggerEvent;
    expect(eventTitle(event)).toBe("github:pr_comment");
    expect(eventTitle({ ...event, summary: "PR comment from alice" })).toBe("PR comment from alice");
  });

  test("respondable statuses", () => {
    expect(isRespondableDelivery(delivery("pending"))).toBe(true);
    expect(isRespondableDelivery(delivery("delivered"))).toBe(true);
    expect(isRespondableDelivery(delivery("escalated"))).toBe(true);
    expect(isRespondableDelivery(delivery("responded"))).toBe(false);
    expect(isRespondableDelivery(delivery("expired"))).toBe(false);
  });
});

describe("canRespond", () => {
  test("the server-stamped respondable field wins", () => {
    // Contract-bearing answered delivery: status heuristic would say false,
    // expired+respondable view field says true (better late).
    expect(canRespond({ ...delivery("responded"), respondable: true })).toBe(true);
    // Contract-less pending delivery: old servers rendered controls that 400.
    expect(canRespond({ ...delivery("pending"), respondable: false })).toBe(false);
  });

  test("falls back to the status heuristic when the field is absent (older server)", () => {
    expect(canRespond(delivery("pending"))).toBe(true);
    expect(canRespond(delivery("responded"))).toBe(false);
    expect(canRespond({ ...delivery("pending"), response: { text: "done" } })).toBe(false);
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-08-28T12:00:00Z");
  test("buckets relative time", () => {
    expect(timeAgo("2026-08-28T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-08-28T11:30:00Z", now)).toBe("30m ago");
    expect(timeAgo("2026-08-28T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-08-25T12:00:00Z", now)).toBe("3d ago");
  });

  test("falls back to an absolute date past a week and tolerates garbage", () => {
    expect(/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(timeAgo("2026-07-01T12:00:00Z", now))).toBe(true);
    expect(timeAgo("not-a-date", now)).toBe("");
  });
});
describe("route form helpers", () => {
  const def = (overrides: Partial<ServiceTriggerParamDef>): ServiceTriggerParamDef => ({
    name: "p",
    label: "P",
    type: "string",
    ...overrides,
  });

  test("formatParamValue renders strings and JSON for other types", () => {
    expect(formatParamValue("repo")).toBe("repo");
    expect(formatParamValue(42)).toBe("42");
    expect(formatParamValue(true)).toBe("true");
    expect(formatParamValue(null)).toBe("null");
    expect(formatParamValue({ a: 1 })).toBe('{"a":1}');
  });

  test("parseParamInput coerces per declared type", () => {
    expect(parseParamInput(def({ type: "number" }), "42")).toEqual({ ok: true, value: 42 });
    expect(parseParamInput(def({ type: "number" }), "nope").ok).toBe(false);
    expect(parseParamInput(def({ type: "boolean" }), "true")).toEqual({ ok: true, value: true });
    expect(parseParamInput(def({ type: "json" }), '{"k":[1]}')).toEqual({ ok: true, value: { k: [1] } });
    expect(parseParamInput(def({ type: "json" }), "{nope").ok).toBe(false);
    expect(parseParamInput(def({ type: "string" }), "hello")).toEqual({ ok: true, value: "hello" });
  });

  test("parseParamInput enforces required and optional-empty semantics", () => {
    expect(parseParamInput(def({ required: true }), " ").ok).toBe(false);
    expect(parseParamInput(def({ required: true }), " x ")).toEqual({ ok: true, value: "x" });
    // Optional + empty = omit the param entirely.
    expect(parseParamInput(def({}), "")).toEqual({ ok: true, value: undefined });
  });

  test("parseParamInput handles enum multiselects with typed values", () => {
    const multi = def({ type: "number", enum: [1, 2, 3], multiselect: true, required: true });
    expect(parseParamInput(multi, [])).toEqual({ ok: false, error: '"P" requires at least one selection' });
    expect(parseParamInput(multi, ["1", "2"])).toEqual({ ok: true, value: [1, 2] });
    const boolMulti = def({ type: "boolean", enum: [true, false], multiselect: true });
    expect(parseParamInput(boolMulti, ["true", "false"])).toEqual({ ok: true, value: [true, false] });
  });

  test("parseFilterValue types by schema, never guesses for unknown fields", () => {
    expect(parseFilterValue("42", "number")).toBe(42);
    expect(parseFilterValue("true", "boolean")).toBe(true);
    expect(parseFilterValue("true")).toBe("true");
    expect(parseFilterValue("42")).toBe("42");
  });
});
