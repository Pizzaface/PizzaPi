import { afterEach, expect, spyOn, test } from "bun:test";
import { startMic, type MicHandlers } from "./audio";
import * as vad from "./vad";

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { spy?.mockRestore(); });
const handlers: MicHandlers = { onSpeechStart() {}, onAudio() {}, onSpeechEnd() {}, onDiscard() {}, onLevel() {}, onError() {} };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function audioFixture() {
    const processor = { onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null, connect() { return this; }, disconnect() {} };
    const ctx = {
        sampleRate: 16000, destination: {},
        createScriptProcessor: () => processor,
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
        createGain: () => ({ gain: { value: 0 }, connect() { return this; }, disconnect() {} }),
    } as unknown as AudioContext;
    const frame = { inputBuffer: { getChannelData: () => new Float32Array(2048) } } as unknown as AudioProcessingEvent;
    return { ctx, processor, frame };
}
function streamFixture() {
    let stops = 0;
    const track = { enabled: true, stop: () => { stops++; } };
    return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, stops: () => stops };
}

test("mute/unmute fences a late inference result and subsequent frames still work", async () => {
    const fixture = streamFixture();
    const { ctx, processor, frame } = audioFixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    spy = spyOn(vad, "createSpeechDetector").mockImplementation(async (_rate, events) => ({
        process: async () => { await pending; events.start(); },
        reset() {}, destroy: async () => {},
    }));
    const mic = await startMic(ctx, { ...handlers, onSpeechStart: () => { starts++; } }, Promise.resolve(fixture.stream));
    try {
        processor.onaudioprocess!(frame);
        mic.setMuted(true);
        mic.setMuted(false);
        release();
        await settle();
        expect(starts).toBe(0);
        processor.onaudioprocess!(frame);
        await settle();
        expect(starts).toBe(1);
    } finally { mic.stop(); }
});

test("inference failure stops capture rather than retrying every audio frame", async () => {
    const fixture = streamFixture();
    const { ctx, processor, frame } = audioFixture();
    let calls = 0, errors = 0, released = 0;
    spy = spyOn(vad, "createSpeechDetector").mockResolvedValue({
        process: async () => { calls++; throw new Error("inference failed"); },
        reset() {}, destroy: async () => { released++; },
    });
    const mic = await startMic(ctx, { ...handlers, onError: () => { errors++; } }, Promise.resolve(fixture.stream));
    try {
        const callback = processor.onaudioprocess!;
        callback(frame);
        await settle();
        callback(frame);
        await settle();
        expect(calls).toBe(1);
        expect(errors).toBe(1);
        expect(released).toBe(1);
        expect(fixture.stops()).toBe(1);
        expect(processor.onaudioprocess).toBeNull();
    } finally { mic.stop(); }
});

test("model load failure releases the pre-approved microphone", async () => {
    const fixture = streamFixture();
    spy = spyOn(vad, "createSpeechDetector").mockRejectedValue(new Error("model unavailable"));
    await expect(startMic({ sampleRate: 16000 } as AudioContext, handlers, Promise.resolve(fixture.stream))).rejects.toThrow("model unavailable");
    expect(fixture.stops()).toBe(1);
});

test("closing while detector loads releases late resources without opening audio nodes", async () => {
    const fixture = streamFixture();
    const ac = new AbortController();
    let released = 0;
    let resolve!: (value: Awaited<ReturnType<typeof vad.createSpeechDetector>>) => void;
    spy = spyOn(vad, "createSpeechDetector").mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = startMic({ sampleRate: 16000 } as AudioContext, handlers, Promise.resolve(fixture.stream), ac.signal);
    void pending.catch(() => {});
    await settle();
    ac.abort();
    resolve({ process: async () => {}, reset() {}, destroy: async () => { released++; } });
    await expect(pending).rejects.toThrow();
    expect(released).toBe(1);
    expect(fixture.stops()).toBe(1);
});

test("audio graph failure releases the loaded model and stream", async () => {
    const fixture = streamFixture();
    let released = 0;
    spy = spyOn(vad, "createSpeechDetector").mockResolvedValue({ process: async () => {}, reset() {}, destroy: async () => { released++; } });
    const ctx = { sampleRate: 16000, createMediaStreamSource() { throw new Error("context closed"); } } as unknown as AudioContext;
    await expect(startMic(ctx, handlers, Promise.resolve(fixture.stream))).rejects.toThrow("context closed");
    expect(released).toBe(1);
    expect(fixture.stops()).toBe(1);
});

test("frames arriving during a slow inference are queued in order, not dropped", async () => {
    const fixture = streamFixture();
    const { ctx, processor } = audioFixture();
    const releases: Array<() => void> = [];
    const seen: number[] = [];
    spy = spyOn(vad, "createSpeechDetector").mockImplementation(async () => ({
        process: (frame: Float32Array) => new Promise<void>((resolve) => { seen.push(frame[0]!); releases.push(resolve); }),
        reset() {}, destroy: async () => {},
    }));
    const frame = (v: number) => ({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(v) } } as unknown as AudioProcessingEvent);
    const mic = await startMic(ctx, handlers, Promise.resolve(fixture.stream));
    try {
        processor.onaudioprocess!(frame(1));
        processor.onaudioprocess!(frame(2));
        processor.onaudioprocess!(frame(3));
        expect(seen).toEqual([1]);
        releases.shift()!();
        await settle();
        releases.shift()!();
        await settle();
        expect(seen).toEqual([1, 2, 3]);
    } finally { mic.stop(); }
});
