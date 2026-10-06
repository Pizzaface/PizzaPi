/**
 * Relay-side tunnel resource bounds: per-request body limits in both
 * directions, a per-runner in-flight cap, runner-driven request pause/resume,
 * and send-buffer backpressure.
 */
import { describe, expect, test } from "bun:test";
import { TunnelRelay, TUNNEL_SEND_HIGH_WATER_BYTES, type TunnelRelayLimits } from "./server.js";

type Listener = (event?: unknown) => void;

function createMockRunnerSocket() {
  const sent: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
    },
    close() {},
    addEventListener(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };
  const emit = (payload: unknown) => {
    for (const listener of listeners.get("message") ?? []) listener({ data: JSON.stringify(payload) });
  };
  return { ws, sent, emit, messages: () => sent.map((s) => JSON.parse(s) as Record<string, unknown>) };
}

async function registeredRelay(limits: Partial<TunnelRelayLimits>) {
  const relay = new TunnelRelay({ apiKeys: ["k"], limits });
  const runner = createMockRunnerSocket();
  relay.handleConnection(runner.ws as unknown as WebSocket);
  runner.emit({ type: "register", runnerId: "r1", apiKey: "k" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(relay.hasRunner("r1")).toBe(true);
  return { relay, runner };
}

function recorder() {
  const errors: string[] = [];
  const data: Buffer[] = [];
  return {
    errors,
    data,
    callbacks: {
      onResponseStart() {},
      onResponseData(chunk: Buffer) {
        data.push(chunk);
      },
      onResponseEnd() {},
      onError(error: string) {
        errors.push(error);
      },
    },
  };
}

const req = (id: string) => ({ id, port: 3000, method: "POST", url: "/", headers: {} });

describe("TunnelRelay limits", () => {
  test("rejects invalid limits", () => {
    expect(() => new TunnelRelay({ apiKeys: ["k"], limits: { maxBufferedBytes: -1 } })).toThrow();
    expect(() => new TunnelRelay({ apiKeys: ["k"], limits: { maxRequestBodyBytes: Number.NaN } })).toThrow();
  });

  test("terminates a request whose streamed body exceeds maxRequestBodyBytes", async () => {
    const { relay, runner } = await registeredRelay({ maxRequestBodyBytes: 10 });
    const rec = recorder();
    relay.proxyHttpRequest("r1", req("q1"), rec.callbacks);

    expect(relay.sendRequestData("r1", "q1", Buffer.alloc(6))).toBe(true);
    expect(relay.sendRequestData("r1", "q1", Buffer.alloc(6))).toBe(false);

    expect(rec.errors).toEqual(["Request body too large"]);
    const msgs = runner.messages();
    expect(msgs.filter((m) => m.type === "request-data")).toHaveLength(1);
    expect(msgs.at(-1)).toEqual({ type: "request-end", id: "q1" });
    // Late runner frames for the aborted request are ignored.
    runner.emit({ type: "response-start", id: "q1", statusCode: 200, statusMessage: "OK", headers: {} });
    expect(rec.errors).toHaveLength(1);
  });

  test("terminates a response that exceeds maxResponseBodyBytes", async () => {
    const { relay, runner } = await registeredRelay({ maxResponseBodyBytes: 10 });
    const rec = recorder();
    relay.proxyHttpRequest("r1", req("q2"), rec.callbacks);
    runner.emit({ type: "response-start", id: "q2", statusCode: 200, statusMessage: "OK", headers: {} });
    runner.emit({ type: "response-data", id: "q2", data: "x".repeat(8) });
    runner.emit({ type: "response-data", id: "q2", data: "x".repeat(8) });
    runner.emit({ type: "response-data", id: "q2", data: "x".repeat(8) });

    expect(rec.data.reduce((n, b) => n + b.length, 0)).toBe(8);
    expect(rec.errors).toEqual(["Response body too large"]);
    expect(runner.messages().at(-1)).toEqual({ type: "request-end", id: "q2" });
  });

  test("caps concurrent HTTP requests and WebSockets per runner", async () => {
    const { relay, runner } = await registeredRelay({ maxInFlightPerRunner: 2 });
    const a = recorder();
    const b = recorder();
    const c = recorder();
    relay.proxyHttpRequest("r1", req("i1"), a.callbacks);
    relay.proxyWsOpen("r1", { id: "i2", port: 3000, path: "/", headers: {} }, {
      onOpened() {}, onData() {}, onClose() {}, onError(message) { b.errors.push(message); },
    });
    relay.proxyHttpRequest("r1", req("i3"), c.callbacks);

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(c.errors).toEqual(["Too many concurrent tunnel requests for this runner"]);

    // A slot frees up once a request completes.
    runner.emit({ type: "response-start", id: "i1", statusCode: 200, statusMessage: "OK", headers: {} });
    runner.emit({ type: "response-data-end", id: "i1" });
    const d = recorder();
    relay.proxyHttpRequest("r1", req("i4"), d.callbacks);
    expect(d.errors).toEqual([]);
    relay.dispose();
  });

  test("waits while the runner pauses the request body and resumes on request-resume", async () => {
    const { relay, runner } = await registeredRelay({});
    relay.proxyHttpRequest("r1", req("p1"), recorder().callbacks);
    runner.emit({ type: "request-pause", id: "p1" });

    let ready = false;
    const waiting = relay.waitForRequestCapacity("r1", "p1").then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ready).toBe(false);

    runner.emit({ type: "request-resume", id: "p1" });
    await waiting;
    expect(ready).toBe(true);
    relay.dispose();
  });

  test("applies backpressure while the runner socket send buffer is above the high-water mark", async () => {
    const { relay, runner } = await registeredRelay({});
    relay.proxyHttpRequest("r1", req("p2"), recorder().callbacks);
    runner.ws.bufferedAmount = TUNNEL_SEND_HIGH_WATER_BYTES + 1;
    expect(relay.isRunnerCongested("r1")).toBe(true);

    let ready = false;
    const waiting = relay.waitForRequestCapacity("r1", "p2").then(() => {
      ready = true;
    });
    const drained = relay.waitForRunnerDrain("r1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ready).toBe(false);

    runner.ws.bufferedAmount = 0;
    await Promise.all([waiting, drained]);
    expect(ready).toBe(true);
    relay.dispose();
  });

  test("forwards response-pause / response-resume to the owning runner only for live requests", async () => {
    const { relay, runner } = await registeredRelay({});
    relay.proxyHttpRequest("r1", req("f1"), recorder().callbacks);
    relay.pauseResponse("r1", "f1");
    relay.resumeResponse("r1", "f1");
    relay.pauseResponse("r1", "unknown");
    const flow = runner.messages().filter((m) => String(m.type).startsWith("response-"));
    expect(flow).toEqual([
      { type: "response-pause", id: "f1" },
      { type: "response-resume", id: "f1" },
    ]);
    relay.dispose();
  });

  test("viewer→runner request-body chunks that would cross maxBufferedBytes (serialized frame + queued) fail the request", async () => {
    // Body limit is generous; only the hard buffer ceiling applies.
    const { relay, runner } = await registeredRelay({ maxBufferedBytes: 200, maxRequestBodyBytes: 1024 });
    const rec = recorder();
    relay.proxyHttpRequest("r1", req("b1"), rec.callbacks);

    // A 100-byte chunk of high bytes serializes (binary string → JSON \u escapes)
    // to a frame far larger than 200 bytes even on an empty socket.
    const chunk = Buffer.alloc(100, 0x80);
    const frame = JSON.stringify({ type: "request-data", id: "b1", data: chunk.toString("binary") });
    expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(200);
    expect(relay.sendRequestData("r1", "b1", chunk)).toBe(false);
    expect(runner.messages().filter((m) => m.type === "request-data")).toEqual([]);
    expect(rec.errors).toEqual(["Tunnel buffer limit exceeded"]);
    expect(runner.messages().at(-1)).toEqual({ type: "request-end", id: "b1" });

    // A small chunk fits on an empty socket ...
    const rec2 = recorder();
    relay.proxyHttpRequest("r1", req("b2"), rec2.callbacks);
    expect(relay.sendRequestData("r1", "b2", Buffer.from("ok"))).toBe(true);
    expect(runner.messages().filter((m) => m.type === "request-data")).toHaveLength(1);
    // ... but already-queued runner bytes count against the ceiling too.
    runner.ws.bufferedAmount = 180;
    expect(relay.sendRequestData("r1", "b2", Buffer.from("ok"))).toBe(false);
    expect(runner.messages().filter((m) => m.type === "request-data")).toHaveLength(1);
    expect(rec2.errors).toEqual(["Tunnel buffer limit exceeded"]);
    relay.dispose();
  });

  test("viewer→runner WebSocket frames that would cross maxBufferedBytes close the stream instead of queueing", async () => {
    const { relay, runner } = await registeredRelay({ maxBufferedBytes: 64 });
    const closes: Array<number | undefined> = [];
    relay.proxyWsOpen("r1", { id: "v1", port: 3000, path: "/", headers: {} }, {
      onOpened() {}, onData() {}, onClose(code) { closes.push(code); }, onError() {},
    });
    runner.emit({ type: "ws-opened", id: "v1" });

    // Empty runner socket, but the serialized frame alone exceeds the ceiling.
    expect(relay.sendWsData("r1", "v1", "x".repeat(100))).toBe(false);
    expect(runner.messages().filter((m) => m.type === "ws-data")).toEqual([]);
    expect(runner.messages().at(-1)).toMatchObject({ type: "ws-close", id: "v1", code: 1013 });
    expect(closes).toEqual([1013]);

    // A frame that fits is forwarded.
    relay.proxyWsOpen("r1", { id: "v2", port: 3000, path: "/", headers: {} }, {
      onOpened() {}, onData() {}, onClose() {}, onError() {},
    });
    expect(relay.sendWsData("r1", "v2", "ok")).toBe(true);
    expect(runner.messages().filter((m) => m.type === "ws-data")).toEqual([{ type: "ws-data", id: "v2", data: "ok" }]);

    // Already-queued bytes count too.
    runner.ws.bufferedAmount = 40;
    expect(relay.sendWsData("r1", "v2", "ok")).toBe(false);
    relay.dispose();
  });
});
