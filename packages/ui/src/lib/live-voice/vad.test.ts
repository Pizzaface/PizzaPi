import { expect, test } from "bun:test";
import { speechDetector, SPEECH_OPTIONS } from "./vad";

function setup(probability: (frame: Float32Array) => number = (f) => f[0]!) {
    const events: string[] = [];
    const chunks: Float32Array[] = [];
    const detector = speechDetector({
        process: async (frame) => ({ isSpeech: probability(frame), notSpeech: 1 - probability(frame) }),
        reset_state() {}, release: async () => {},
    }, 16000, {
        start: () => events.push("start"), discard: () => events.push("discard"),
        audio: (samples) => { events.push("audio"); chunks.push(samples); },
        end: () => events.push("end"),
    });
    const feed = async (frames: number, value: number) => {
        for (let i = 0; i < frames; i++) await detector.process(new Float32Array(512).fill(value), () => true);
    };
    return { events, chunks, detector, feed };
}

test("loud non-speech does not pause or submit an utterance", async () => {
    const { feed, events, detector } = setup(() => 0.01);
    await feed(40, 0.9); // loud samples, low speech probability
    await feed(20, 0);
    expect(events).toEqual([]);
    await detector.destroy();
});

test("short speech-like blips are discarded without interrupting playback", async () => {
    const { feed, events, detector } = setup();
    await feed(3, 0.95);
    await feed(20, 0);
    expect(events).toEqual(["discard"]);
    await detector.destroy();
});

test("a short spoken command qualifies and ends after the configured silence", async () => {
    const { feed, events, chunks, detector } = setup();
    await feed(SPEECH_OPTIONS.minSpeechMs / 32, 0.95);
    expect(events).toEqual(["start", "audio"]);
    await feed(Math.floor(SPEECH_OPTIONS.redemptionMs / 32), 0);
    expect(events.at(-1)).toBe("end");
    expect(events.filter((e) => e === "start")).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(1);
    await detector.destroy();
});

test("confirmed speech streams pre-roll first, then each frame while talking, all before end", async () => {
    // Value encodes the frame index so ordering is checkable: silence frames are tiny, speech is 0.95.
    const { feed, events, chunks, detector } = setup((f) => (f[0]! > 0.5 ? 0.95 : 0.01));
    const preRoll = Math.floor(SPEECH_OPTIONS.preSpeechPadMs / 32);
    for (let i = 0; i < 20; i++) await detector.process(new Float32Array(512).fill(0.001 * (i + 1)), () => true);
    expect(events).toEqual([]); // silence is never sent
    const minFrames = SPEECH_OPTIONS.minSpeechMs / 32;
    await feed(minFrames - 1, 0.95);
    expect(events).toEqual([]); // candidate speech is held, not sent
    await feed(1, 0.95);
    expect(events).toEqual(["start", "audio"]);
    const first = chunks[0]!;
    expect(first.length).toBe((preRoll + minFrames) * 512);
    // The pre-roll is the most recent silence, oldest first.
    expect(first[0]).toBeCloseTo(0.001 * (20 - preRoll + 1));
    expect(first[(preRoll - 1) * 512]).toBeCloseTo(0.02);
    await feed(3, 0.95);
    expect(events).toEqual(["start", "audio", "audio", "audio", "audio"]); // one chunk per frame, live
    await feed(Math.floor(SPEECH_OPTIONS.redemptionMs / 32), 0);
    expect(events.at(-1)).toBe("end");
    const streamed = chunks.reduce((n, c) => n + c.length, 0);
    expect(streamed).toBe((preRoll + minFrames + 3 + Math.floor(SPEECH_OPTIONS.redemptionMs / 32)) * 512);
    await detector.destroy();
});

test("reset discards partial speech instead of carrying it into the next capture", async () => {
    const { feed, events, detector } = setup();
    await feed(3, 0.95);
    detector.reset();
    await feed(3, 0.95);
    await feed(20, 0);
    expect(events).toEqual(["discard"]);
    await detector.destroy();
});
