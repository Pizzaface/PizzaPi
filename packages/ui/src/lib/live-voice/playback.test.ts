import { expect, test } from "bun:test";
import { PlaybackQueue } from "./audio";

function setup() {
    const sources: Array<{ buffer: AudioBuffer | null; onended: (() => void) | null; offset: number; connect(): void; disconnect(): void; start(when?: number, offset?: number): void; stop(): void }> = [];
    const ctx = {
        currentTime: 0,
        destination: {},
        createAnalyser: () => ({ connect() {}, fftSize: 256 }),
        decodeAudioData: async () => ({ duration: 10 }) as AudioBuffer,
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
    return { ctx, sources, queue: new PlaybackQueue(ctx as unknown as AudioContext, () => {}, () => {}) };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const wav = async () => new ArrayBuffer(1);

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
