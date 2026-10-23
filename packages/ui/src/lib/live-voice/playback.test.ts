import { expect, test } from "bun:test";
import { playbackBounds, PlaybackQueue } from "./audio";

function setup() {
    const gain = { gain: { value: 1 }, connect() {} };
    const sources: Array<{ buffer: AudioBuffer | null; onended: (() => void) | null; offset: number; connect(): void; disconnect(): void; start(when?: number, offset?: number): void; stop(): void }> = [];
    const ctx = {
        currentTime: 0,
        destination: {},
        createAnalyser: () => ({ connect() {}, fftSize: 256 }),
        createGain: () => gain,
        decodeAudioData: async () => ({ duration: 10, length: 1000, sampleRate: 100, numberOfChannels: 1, getChannelData: () => new Float32Array(1000).fill(0.1) }) as AudioBuffer,
        createBufferSource: () => {
            const source = {
                buffer: null as AudioBuffer | null,
                onended: null as (() => void) | null,
                offset: 0,
                connect() {}, disconnect() {},
                start(_when = 0, offset = 0) { this.offset = offset; },
                stop() { this.onended?.(); },
            };
            sources.push(source);
            return source;
        },
    };
    return { ctx, gain, sources, queue: new PlaybackQueue(ctx as unknown as AudioContext, () => {}, () => {}) };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const wav = async () => new ArrayBuffer(1);

test("sentence playback trims model padding but retains a short natural pause", () => {
    const samples = new Float32Array(2000);
    samples.fill(0.1, 320, 1580);
    const buffer = { length: samples.length, duration: 2, sampleRate: 1000, numberOfChannels: 1, getChannelData: () => samples } as unknown as AudioBuffer;
    expect(playbackBounds(buffer).start).toBeCloseTo(0.24);
    expect(playbackBounds(buffer).end).toBeCloseTo(1.66);
    samples.fill(0);
    expect(playbackBounds(buffer)).toEqual({ start: 0, end: 0 });
});

test("duck lowers the voice; resume or clear restores it even when playback was never paused", () => {
    const { gain, queue } = setup();
    queue.duck(true);
    expect(gain.gain.value).toBeLessThan(0.5);
    queue.resume();
    expect(gain.gain.value).toBe(1);
    queue.duck(true);
    queue.clear();
    expect(gain.gain.value).toBe(1);
});

test("false interruption resumes current clip at its offset and preserves queued clips", async () => {
    const { ctx, sources, queue } = setup();
    const captions: string[] = [];
    queue.enqueue(wav, () => captions.push("first"));
    queue.enqueue(wav, () => captions.push("second"));
    await settle();
    ctx.currentTime = 3;
    queue.pause();
    await settle();
    expect(queue.playing).toBe(false);
    expect(sources).toHaveLength(1);
    ctx.currentTime = 20;
    queue.resume();
    await settle();
    expect(sources).toHaveLength(2);
    expect(sources[1]!.offset).toBe(3);
    sources[1]!.onended?.();
    await settle();
    expect(sources).toHaveLength(3);
    expect(captions).toEqual(["first", "first", "second"]);
    sources[2]!.onended?.();
    await settle();
    expect(queue.playing).toBe(false);
});

test("pausing while TTS is loading prevents late audio until resumed", async () => {
    const { sources, queue } = setup();
    let resolve!: (wav: ArrayBuffer) => void;
    queue.enqueue(() => new Promise((r) => { resolve = r; }));
    queue.pause();
    resolve(new ArrayBuffer(1));
    await settle();
    expect(sources).toHaveLength(0);
    queue.resume();
    await settle();
    expect(sources).toHaveLength(1);
    queue.clear();
});

test("confirmed interruption clears paused clips without blocking the next reply", async () => {
    const { sources, queue } = setup();
    queue.enqueue(wav);
    queue.enqueue(wav);
    await settle();
    queue.pause();
    await settle();
    queue.clear();
    queue.enqueue(wav);
    await settle();
    expect(sources).toHaveLength(2);
    expect(sources[1]!.offset).toBe(0);
    sources[1]!.onended?.();
    await settle();
    expect(queue.playing).toBe(false);
});
