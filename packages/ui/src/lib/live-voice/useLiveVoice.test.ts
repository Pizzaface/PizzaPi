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

const originalFetch = globalThis.fetch;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
afterEach(() => {
    cleanup();
    detectorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const utterance of ["noise", "discard", "empty", "real", "mute", "failure"] as const) {
    test(`Live ${utterance} interruption preserves or replaces queued speech appropriately`, async () => {
        const sent: string[] = [];
        let sttCalls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/api/tunnel-token")) return Response.json({ url: "/api/tunnel/auth/test/" });
            if (url.endsWith("/api/status")) return Response.json({ stt: "ready", tts: "ready" });
            if (url.endsWith("/api/tts")) return new Response(new ArrayBuffer(1));
            if (url.endsWith("/api/stt")) {
                sttCalls++;
                if (utterance === "failure") return Response.json({ error: "transcription unavailable" }, { status: 503 });
                return Response.json({ text: utterance === "real" ? "Stop please" : "  " });
            }
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
        if (utterance === "mute") act(() => result.current.setMuted(true));
        await act(async () => { await feed(8, 0.001); });
        expect(sttCalls).toBe(nonSpeech || utterance === "mute" ? 0 : 1);
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
