import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useLiveVoice } from "./useLiveVoice";

const originalFetch = globalThis.fetch;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
});
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const utterance of ["discard", "empty", "real"] as const) {
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
                return Response.json({ text: utterance === "real" ? "Stop please" : "  " });
            }
            return Response.json({});
        }) as typeof fetch;
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => {};
        const sources: Array<{ onended: (() => void) | null; offset: number }> = [];
        const processor = { onaudioprocess: null as ((event: any) => void) | null, connect() { return this; }, disconnect() {} };
        const ctx = {
            sampleRate: 40960, currentTime: 0, destination: {}, close: async () => {},
            createAnalyser: () => ({ connect() {}, fftSize: 256 }),
            createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
            createScriptProcessor: () => processor,
            createGain: () => ({ gain: { value: 0 }, connect() { return this; }, disconnect() {} }),
            decodeAudioData: async () => ({ duration: 10 }),
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
        const feed = (count: number, amplitude: number) => {
            for (let i = 0; i < count; i++) processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(amplitude) } });
        };
        await act(async () => { feed(utterance === "discard" ? 3 : 10, 0.1); await settle(); });
        expect(result.current.phase).toBe("hearing");
        // Reply text can finish while the potential interruption is assessed.
        await act(async () => { rerender({ text: "First sentence. Second sentence. Third sentence." }); await settle(); });
        expect(sources).toHaveLength(1);
        await act(async () => { feed(20, 0.001); await settle(); });
        expect(sttCalls).toBe(utterance === "discard" ? 0 : 1);
        if (utterance === "real") {
            expect(sent).toEqual(["Stop please"]);
            expect(sources).toHaveLength(1);
        } else {
            expect(sent).toEqual([]);
            expect(result.current.phase).toBe("speaking");
            expect(sources).toHaveLength(2);
            expect(sources[1]!.offset).toBe(2);
            await act(async () => { sources[1]!.onended?.(); await settle(); });
            expect(sources).toHaveLength(3);
            await act(async () => { sources[2]!.onended?.(); await settle(); });
            expect(sources).toHaveLength(4);
            await act(async () => { sources[3]!.onended?.(); await settle(); });
            expect(result.current.phase).toBe("listening");
        }
    });
}
