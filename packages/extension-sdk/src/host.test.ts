import { describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { PizzaPiHostAPI, PizzaPiHostInfo } from "./host.js";
import { detectPizzaPiHost, isPizzaPiHostInfo, onPizzaPiHost } from "./host.js";

const fakePi = (events: ReturnType<typeof createEventBus>): PizzaPiHostAPI => ({ events });

function respond(data: unknown, value: unknown): void {
  if (!data || typeof data !== "object" || !("respond" in data)) return;
  const callback = (data as { respond?: unknown }).respond;
  if (typeof callback === "function") callback(value);
}

describe("isPizzaPiHostInfo", () => {
  test("accepts a valid host info payload", () => {
    expect(isPizzaPiHostInfo({ apiVersion: 1, capabilities: ["panels", "triggers"] })).toBe(true);
  });

  test("rejects malformed payloads", () => {
    expect(isPizzaPiHostInfo(undefined)).toBe(false);
    expect(isPizzaPiHostInfo(null)).toBe(false);
    expect(isPizzaPiHostInfo({ apiVersion: 2, capabilities: [] })).toBe(false);
    expect(isPizzaPiHostInfo({ apiVersion: 1, capabilities: ["ok", 1] })).toBe(false);
    expect(isPizzaPiHostInfo({ apiVersion: 1 })).toBe(false);
  });
});

describe("detectPizzaPiHost", () => {
  test("returns undefined when no host responds (vanilla pi)", () => {
    expect(detectPizzaPiHost(fakePi(createEventBus()))).toBeUndefined();
  });

  test("pins pi's real event bus synchronous first-tick dispatch", () => {
    const bus = createEventBus();
    const info: PizzaPiHostInfo = { apiVersion: 1, capabilities: ["panels"] };
    bus.on("pizzapi:host:probe", (data) => respond(data, info));
    expect(detectPizzaPiHost(fakePi(bus))).toEqual(info);
  });

  test("does not accept a response deferred past emit", async () => {
    const bus = createEventBus();
    const info: PizzaPiHostInfo = { apiVersion: 1, capabilities: ["panels"] };
    bus.on("pizzapi:host:probe", async (data) => {
      await Promise.resolve();
      respond(data, info);
    });
    expect(detectPizzaPiHost(fakePi(bus))).toBeUndefined();
    await Promise.resolve();
  });

  test("ignores an invalid synchronous response", () => {
    const bus = createEventBus();
    bus.on("pizzapi:host:probe", (data) => respond(data, { bogus: true }));
    expect(detectPizzaPiHost(fakePi(bus))).toBeUndefined();
  });
});

describe("onPizzaPiHost", () => {
  test("delivers immediately when the probe succeeds synchronously", () => {
    const bus = createEventBus();
    const info: PizzaPiHostInfo = { apiVersion: 1, capabilities: [] };
    bus.on("pizzapi:host:probe", (data) => respond(data, info));
    let delivered: unknown;
    onPizzaPiHost(fakePi(bus), (host) => (delivered = host));
    expect(delivered).toEqual(info);
  });

  test("delivers once from a real-bus ready event", () => {
    const bus = createEventBus();
    const calls: PizzaPiHostInfo[] = [];
    onPizzaPiHost(fakePi(bus), (host) => calls.push(host));

    const info: PizzaPiHostInfo = { apiVersion: 1, capabilities: ["panels"] };
    bus.emit("pizzapi:host:ready", info);
    bus.emit("pizzapi:host:ready", { apiVersion: 1, capabilities: ["should-not-redeliver"] });

    expect(calls).toEqual([info]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = createEventBus();
    const calls: PizzaPiHostInfo[] = [];
    const unsubscribe = onPizzaPiHost(fakePi(bus), (host) => calls.push(host));
    unsubscribe();
    bus.emit("pizzapi:host:ready", { apiVersion: 1, capabilities: [] });
    expect(calls).toEqual([]);
  });
});
