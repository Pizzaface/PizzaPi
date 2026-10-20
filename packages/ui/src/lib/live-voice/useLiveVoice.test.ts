import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useLiveVoice } from "./useLiveVoice";
import * as vad from "./vad";

let detectorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
    // Lifecycle/segmentation tests supply probabilities; the real ONNX model is
    // exercised separately with recorded audio, not synthetic constant samples.
    detectorSpy = spyOn(vad, "createSpeechDetector").mockImplementation(async (rate, events) =>
        vad.speechDetector({
            process: async (frame) => ({ isSpeech: frame[0]! > 0.05 && frame[0]! < 0.2 ? 0.99 : 0.01, notSpeech: 0 }),
            reset_state() {}, release: async () => {},
        }, rate, events));
});

/** Fake Live STT socket: opens immediately, answers `end` via `reply`, records traffic. */
class FakeSttWs {
    static all: FakeSttWs[] = [];
    static reply: (id: number) => object = (id) => ({ type: "final", id, text: "" });
    static partial: string | null = null;
    sent: Array<string | ArrayBuffer> = [];
    readyState = 0; bufferedAmount = 0; binaryType = "blob";
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(public url: string) {
        FakeSttWs.all.push(this);
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
    }
    send(d: string | ArrayBuffer) {
        this.sent.push(d);
        if (typeof d !== "string") {
            if (FakeSttWs.partial) this.#emit({ type: "partial", id: this.#current, text: FakeSttWs.partial });
            return;
        }
        const m = JSON.parse(d);
        if (m.type === "start") this.#current = m.id;
        if (m.type === "end") queueMicrotask(() => this.#emit(FakeSttWs.reply(m.id)));
    }
    close() { this.readyState = 3; }
    messages() { return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d).type as string); }
    #current = 0;
    #emit(o: object) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(o) })); }
}
const originalWebSocket = globalThis.WebSocket;
beforeEach(() => {
    FakeSttWs.all = [];
    FakeSttWs.partial = null;
    globalThis.WebSocket = FakeSttWs as unknown as typeof WebSocket;
});

const originalFetch = globalThis.fetch;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
afterEach(() => {
    cleanup();
    detectorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const utterance of ["noise", "discard", "empty", "echo", "real", "mute", "failure", "drop"] as const) {
    test(`Live ${utterance} interruption preserves or replaces queued speech appropriately`, async () => {
        const sent: string[] = [];
        FakeSttWs.reply = (id) => utterance === "failure"
            ? { type: "error", id, message: "transcription unavailable" }
            : { type: "final", id, text: utterance === "real" ? "Stop please" : utterance === "echo" ? "first sentence" : "  " };
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/api/tunnel-token")) return Response.json({ url: "/api/tunnel/auth/test/" });
            if (url.endsWith("/api/status")) return Response.json({ stt: "ready", tts: "ready" });
            if (url.endsWith("/api/tts")) return new Response(new ArrayBuffer(1));
            return Response.json({});
        }) as typeof fetch;
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => {};
        const sources: Array<{ onended: (() => void) | null; offset: number }> = [];
        const processor = { onaudioprocess: null as ((event: any) => void) | null, connect() { return this; }, disconnect() {} };
        const ctx = {
            sampleRate: 16000, currentTime: 0, destination: {}, close: async () => {},
            createAnalyser: () => ({ connect() {}, fftSize: 256 }),
            createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
            createScriptProcessor: () => processor,
            createGain: () => ({ gain: { value: 0 }, connect() { return this; }, disconnect() {} }),
            decodeAudioData: async () => ({ duration: 10, length: 1000, sampleRate: 100, numberOfChannels: 1, getChannelData: () => new Float32Array(1000).fill(0.1) }),
            createBufferSource: () => {
                const source = {
                    buffer: null, onended: null as (() => void) | null, offset: 0,
                    connect() {}, disconnect() {},
                    start(_when = 0, offset = 0) { this.offset = offset; },
                    stop() { this.onended?.(); },
                };
                sources.push(source);
                return source;
            },
        };
        const stream = Promise.resolve({ getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
        const { result, rerender } = renderHook(({ text }) => useLiveVoice({
            audioContext: ctx as unknown as AudioContext, micStream: stream,
            sessionId: "test", port: 1234, agentActive: false,
            messages: [{ role: "assistant", content: text }],
            send: (text) => { sent.push(text); return true; },
        }), { initialProps: { text: "" } });
        await act(settle);
        expect(result.current.phase).toBe("listening");
        await act(async () => { rerender({ text: "First sentence. Second sentence." }); await settle(); });
        expect(sources).toHaveLength(1);
        ctx.currentTime = 2;
        const feed = async (count: number, amplitude: number) => {
            for (let i = 0; i < count; i++) {
                processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(amplitude) } });
                await settle();
            }
        };
        const nonSpeech = utterance === "noise" || utterance === "discard";
        await act(async () => { await feed(utterance === "discard" ? 1 : 4, utterance === "noise" ? 0.9 : 0.1); });
        expect(result.current.phase).toBe(nonSpeech ? "speaking" : "hearing");
        // Reply text can finish while the potential interruption is assessed.
        await act(async () => { rerender({ text: "First sentence. Second sentence. Third sentence." }); await settle(); });
        expect(sources).toHaveLength(1);
        if (utterance === "drop") {
            // Socket drops mid-speech: the reply resumes now, not when the VAD ends the turn.
            await act(async () => { FakeSttWs.all[0]!.onclose?.(new CloseEvent("close")); await settle(); });
            expect(sources).toHaveLength(2);
            expect(sources[1]!.offset).toBe(2);
            await act(async () => { await feed(8, 0.001); });
            expect(sent).toEqual([]);
            expect(result.current.error).toBeNull();
            expect(sources).toHaveLength(2);
            return;
        }
        if (utterance === "mute") act(() => result.current.setMuted(true));
        await act(async () => { await feed(8, 0.001); });
        const traffic = FakeSttWs.all[0]!.messages();
        expect(traffic.filter((t) => t === "end")).toHaveLength(nonSpeech || utterance === "mute" ? 0 : 1);
        expect(traffic.filter((t) => t === "start")).toHaveLength(nonSpeech ? 0 : 1);
        if (utterance === "mute") expect(traffic).toContain("cancel");
        // Audio streamed while the user was still talking, not after.
        if (!nonSpeech) expect(FakeSttWs.all[0]!.sent.some((d) => d instanceof ArrayBuffer)).toBe(true);
        if (utterance === "real") {
            expect(sent).toEqual(["Stop please"]);
            expect(sources).toHaveLength(1);
        } else {
            expect(sent).toEqual([]);
            expect(result.current.phase).toBe(utterance === "failure" ? "error" : "speaking");
            const current = nonSpeech ? 0 : 1;
            expect(sources).toHaveLength(current + 1);
            expect(sources[current]!.offset).toBe(nonSpeech ? 0 : 2);
            await act(async () => { sources[current]!.onended?.(); await settle(); });
            expect(sources).toHaveLength(current + 2);
            await act(async () => { sources[current + 1]!.onended?.(); await settle(); });
            expect(sources).toHaveLength(current + 3);
            await act(async () => { sources[current + 2]!.onended?.(); await settle(); });
            expect(result.current.phase).toBe(utterance === "failure" ? "error" : "listening");
        }
    });
}

test("Live speaks the sentence before a tool call without waiting for more text", async () => {
    const spoken: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/tunnel-token")) return Response.json({ url: "/api/tunnel/auth/test/" });
        if (url.endsWith("/api/status")) return Response.json({ stt: "ready", tts: "ready" });
        if (url.endsWith("/api/tts")) {
            spoken.push(JSON.parse(String(init?.body)).text);
            return new Response(new ArrayBuffer(1));
        }
        return Response.json({});
    }) as typeof fetch;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    const node = () => ({ connect() { return this; }, disconnect() {}, gain: { value: 0 }, fftSize: 256, onaudioprocess: null });
    const ctx = {
        sampleRate: 16000, currentTime: 0, destination: {}, close: async () => {},
        createAnalyser: node, createMediaStreamSource: node, createScriptProcessor: node, createGain: node,
        decodeAudioData: async () => ({ duration: 1, length: 100, sampleRate: 100, numberOfChannels: 1, getChannelData: () => new Float32Array(100).fill(0.1) }),
        createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }),
    };
    const stream = Promise.resolve({ getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
    const { rerender } = renderHook(({ text, tools }) => useLiveVoice({
        audioContext: ctx as unknown as AudioContext, micStream: stream,
        sessionId: "test", port: 1234, agentActive: true, activeToolCalls: tools,
        messages: [{ role: "assistant", content: text }],
        send: () => true,
    }), { initialProps: { text: "", tools: new Map<string, string>() } });
    await act(settle);
    await act(async () => { rerender({ text: "Running the build now.", tools: new Map() }); await settle(); });
    expect(spoken).toEqual([]);
    await act(async () => { rerender({ text: "Running the build now.", tools: new Map([["t1", "bash"]]) }); await settle(); });
    expect(spoken).toEqual(["Running the build now."]);
});

for (const ending of ["final", "disconnect", "mute"] as const) {
    test(`partial captions show while talking; ${{ final: "only the final is sent, once", disconnect: "a dropped socket loses the utterance without an error or a send", mute: "muting while awaiting the final withdraws it" }[ending]}`, async () => {
        const sent: string[] = [];
        FakeSttWs.partial = "Run the";
        FakeSttWs.reply = (id) => ({ type: "final", id, text: "Run the tests." });
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/api/tunnel-token")) return Response.json({ url: "/api/tunnel/auth/test/" });
            if (url.endsWith("/api/status")) return Response.json({ stt: "ready", tts: "ready" });
            return Response.json({});
        }) as typeof fetch;
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => {};
        const processor = { onaudioprocess: null as ((event: any) => void) | null, connect() { return this; }, disconnect() {} };
        const node = () => ({ connect() { return this; }, disconnect() {}, gain: { value: 0 }, fftSize: 256 });
        const ctx = {
            sampleRate: 16000, currentTime: 0, destination: {}, close: async () => {},
            createAnalyser: node, createMediaStreamSource: node, createGain: node, createScriptProcessor: () => processor,
        };
        const stream = Promise.resolve({ getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream);
        const { result } = renderHook(() => useLiveVoice({
            audioContext: ctx as unknown as AudioContext, micStream: stream,
            sessionId: "test", port: 1234, agentActive: false, messages: [],
            // The delivery ack never arrives: the mic must keep working anyway.
            send: (text) => { sent.push(text); return new Promise<boolean>(() => {}); },
        }));
        await act(settle);
        expect(result.current.phase).toBe("listening");
        const feed = async (count: number, amplitude: number) => {
            for (let i = 0; i < count; i++) {
                processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(amplitude) } });
                await settle();
            }
        };
        await act(async () => { await feed(4, 0.1); });
        expect(result.current.phase).toBe("hearing");
        expect(result.current.userCaption).toBe("Run the");
        expect(result.current.userCaptionPartial).toBe(true);
        expect(sent).toEqual([]);
        const ws = FakeSttWs.all[0]!;
        if (ending !== "final") ws.send = function (d) { this.sent.push(d); }; // swallow `end`
        await act(async () => { await feed(8, 0.001); });
        if (ending === "mute") {
            expect(result.current.phase).toBe("transcribing");
            act(() => result.current.setMuted(true));
            await act(settle);
            expect(ws.messages()).toContain("cancel");
            ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "final", id: 1, text: "Run the tests." }) }));
            await act(settle);
            expect(sent).toEqual([]);
            expect(result.current.error).toBeNull();
            expect(result.current.userCaption).toBe("");
        } else if (ending === "disconnect") {
            expect(result.current.phase).toBe("transcribing");
            await act(async () => { ws.onclose?.(new CloseEvent("close")); await settle(); });
            expect(sent).toEqual([]);
            expect(result.current.error).toBeNull();
            expect(result.current.userCaption).toBe("");
            expect(result.current.phase).toBe("starting"); // reconnecting
        } else {
            expect(sent).toEqual(["Run the tests."]);
            expect(result.current.userCaption).toBe("Run the tests.");
            expect(result.current.userCaptionPartial).toBe(false);
            ws.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "final", id: 1, text: "again" }) }));
            await act(settle);
            expect(sent).toEqual(["Run the tests."]);
            // Next utterance while the first delivery is still unacknowledged.
            await act(async () => { await feed(4, 0.1); await feed(8, 0.001); });
            expect(ws.messages().filter((t) => t === "start")).toHaveLength(2);
            expect(sent).toEqual(["Run the tests.", "Run the tests."]);
        }
    });
}
