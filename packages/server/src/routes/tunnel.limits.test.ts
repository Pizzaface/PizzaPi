/**
 * End-to-end tunnel resource bounds through the real TunnelRelay and the HTTP
 * proxy bridge: request bodies over the limit are rejected (declared or
 * streamed), slow viewers pause the runner and are terminated at the hard
 * buffer limit, the per-runner in-flight cap maps to 503, and the viewer
 * WebSocket bridge applies backpressure / closes slow viewers.
 */
import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { TunnelRelay, TUNNEL_SEND_HIGH_WATER_BYTES, type TunnelRelayLimits } from "@pizzapi/tunnel";
import { proxyTunnelRequestViaRelay } from "./tunnel";
import { deliverRunnerWsFrame, forwardViewerWsFrame } from "./tunnel-ws";

type Listener = (event?: unknown) => void;

async function relayWithRunner(limits: Partial<TunnelRelayLimits>) {
    const relay = new TunnelRelay({ apiKeys: ["k"], limits });
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
    relay.handleConnection(ws as unknown as WebSocket);
    emit({ type: "register", runnerId: "r1", apiKey: "k" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages = () => sent.map((s) => JSON.parse(s) as { type: string; id?: string; data?: string });
    return { relay, ws, emit, messages };
}

function proxy(relay: TunnelRelay, req: Request, id = "q1") {
    return proxyTunnelRequestViaRelay(req, relay, "r1", id, "", 3000, "/", "/", {});
}

const until = async (predicate: () => boolean, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

describe("tunnel HTTP request-body limits", () => {
    test("rejects a declared Content-Length over the limit before contacting the runner", async () => {
        const { relay, messages } = await relayWithRunner({ maxRequestBodyBytes: 16 });
        const res = await proxy(relay, new Request("http://t/upload", {
            method: "POST",
            body: "x".repeat(32),
            headers: { "content-length": "32" },
        }));
        expect(res.status).toBe(413);
        expect(messages().some((m) => m.type === "request-start")).toBe(false);
        relay.dispose();
    });

    test("terminates a streamed body that exceeds the limit and stops reading it", async () => {
        const { relay, messages } = await relayWithRunner({ maxRequestBodyBytes: 1024 });
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(512));
            },
            cancel() {
                cancelled = true;
            },
        });
        const res = await proxy(relay, new Request("http://t/upload", {
            method: "POST",
            body,
            // @ts-expect-error Bun supports duplex
            duplex: "half",
        }));
        expect(res.status).toBe(413);
        await until(() => cancelled);
        const sentBytes = messages()
            .filter((m) => m.type === "request-data")
            .reduce((n, m) => n + Buffer.from(m.data ?? "", "binary").length, 0);
        expect(sentBytes).toBeLessThanOrEqual(1024);
        expect(messages().some((m) => m.type === "request-end" && m.id === "q1")).toBe(true);
        expect(messages().some((m) => m.type === "request-data-end")).toBe(false);
        expect(pulls).toBeLessThan(10);
        relay.dispose();
    });

    test("maps the per-runner in-flight cap to 503", async () => {
        const { relay } = await relayWithRunner({ maxInFlightPerRunner: 1 });
        void proxy(relay, new Request("http://t/a"), "a");
        const res = await proxy(relay, new Request("http://t/b"), "b");
        expect(res.status).toBe(503);
        relay.dispose();
    });
});

describe("tunnel HTTP response backpressure", () => {
    test("pauses the runner for a slow viewer, resumes when drained, and terminates past the hard limit", async () => {
        const hardLimit = 4 * TUNNEL_SEND_HIGH_WATER_BYTES;
        const { relay, emit, messages } = await relayWithRunner({ maxBufferedBytes: hardLimit });
        const pending = proxy(relay, new Request("http://t/download"));
        emit({ type: "response-start", id: "q1", statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/octet-stream" } });
        const res = await pending;
        expect(res.status).toBe(200);

        const chunk = "x".repeat(256 * 1024);
        // Fill past the high-water mark with nobody reading.
        for (let i = 0; i < 6; i++) emit({ type: "response-data", id: "q1", data: chunk });
        expect(messages().filter((m) => m.type === "response-pause")).toHaveLength(1);

        // The viewer drains → the runner is resumed.
        const reader = res.body!.getReader();
        let drained = 0;
        while (drained < 6 * chunk.length) {
            const { value } = await reader.read();
            drained += value!.byteLength;
        }
        await until(() => messages().some((m) => m.type === "response-resume"));

        // A producer that ignores pause is cut off at the hard limit.
        for (let i = 0; i < 4 * 5; i++) emit({ type: "response-data", id: "q1", data: chunk });
        expect(messages().some((m) => m.type === "request-end" && m.id === "q1")).toBe(true);
        let errored = false;
        try {
            for (;;) {
                const { done } = await reader.read();
                if (done) break;
            }
        } catch {
            errored = true;
        }
        expect(errored).toBe(true);
        relay.dispose();
    });
});

describe("tunnel WebSocket bridge limits", () => {
    function fakeViewer(bufferedAmount = 0) {
        const frames: unknown[] = [];
        return {
            readyState: 1,
            bufferedAmount,
            isPaused: false,
            frames,
            send(data: unknown) {
                frames.push(data);
            },
            pause() {
                this.isPaused = true;
            },
            resume() {
                this.isPaused = false;
            },
        };
    }

    test("pauses the viewer socket while the runner link is congested and resumes after drain", async () => {
        const { relay, ws } = await relayWithRunner({});
        const viewer = fakeViewer();
        ws.bufferedAmount = TUNNEL_SEND_HIGH_WATER_BYTES + 1;
        forwardViewerWsFrame(relay, "r1", "w1", viewer as never, "hi", undefined);
        expect(viewer.isPaused).toBe(true);
        ws.bufferedAmount = 0;
        await until(() => !viewer.isPaused);
        relay.dispose();
    });

    test("closes a viewer whose send buffer exceeds the hard limit", async () => {
        const { relay, messages } = await relayWithRunner({ maxBufferedBytes: 1000 });
        let closed = null as { code?: number } | null;
        relay.proxyWsOpen("r1", { id: "w2", port: 3000, path: "/", headers: {} }, {
            onOpened() {},
            onData() {},
            onClose(code) {
                closed = { code };
            },
            onError() {},
        });
        const viewer = fakeViewer(5000);
        expect(deliverRunnerWsFrame(relay, "r1", "w2", viewer as never, "data", undefined)).toBe(false);
        expect(viewer.frames).toEqual([]);
        expect(closed).toEqual({ code: 1013 });
        expect(messages().at(-1)).toMatchObject({ type: "ws-close", id: "w2", code: 1013 });

        const fast = fakeViewer(0);
        expect(deliverRunnerWsFrame(relay, "r1", "w3", fast as never, "data", undefined)).toBe(true);
        expect(fast.frames).toEqual(["data"]);
        relay.dispose();
    });

    test("counts the runner frame being delivered: an oversized frame to an idle viewer closes it", async () => {
        const { relay, messages } = await relayWithRunner({ maxBufferedBytes: 10 });
        let closed = null as { code?: number } | null;
        relay.proxyWsOpen("r1", { id: "w4", port: 3000, path: "/", headers: {} }, {
            onOpened() {},
            onData() {},
            onClose(code) {
                closed = { code };
            },
            onError() {},
        });
        const viewer = fakeViewer(0);
        expect(deliverRunnerWsFrame(relay, "r1", "w4", viewer as never, "x".repeat(100), undefined)).toBe(false);
        expect(viewer.frames).toEqual([]);
        expect(closed).toEqual({ code: 1013 });
        expect(messages().at(-1)).toMatchObject({ type: "ws-close", id: "w4", code: 1013 });

        // Binary frames are measured after base64 decoding (8 bytes fit).
        const ok = fakeViewer(0);
        expect(deliverRunnerWsFrame(relay, "r1", "w5", ok as never, Buffer.alloc(8).toString("base64"), true)).toBe(true);
        expect(ok.frames).toHaveLength(1);
        relay.dispose();
    });

    test("does not forward a viewer frame that would push the runner link past the ceiling", async () => {
        const { relay, messages } = await relayWithRunner({ maxBufferedBytes: 64 });
        let closed = null as { code?: number } | null;
        relay.proxyWsOpen("r1", { id: "w6", port: 3000, path: "/", headers: {} }, {
            onOpened() {},
            onData() {},
            onClose(code) {
                closed = { code };
            },
            onError() {},
        });
        const viewer = fakeViewer(0);
        forwardViewerWsFrame(relay, "r1", "w6", viewer as never, "x".repeat(100), undefined);
        expect(messages().filter((m) => m.type === "ws-data")).toEqual([]);
        expect(closed).toEqual({ code: 1013 });
        expect(viewer.isPaused).toBe(false);
        relay.dispose();
    });
});
