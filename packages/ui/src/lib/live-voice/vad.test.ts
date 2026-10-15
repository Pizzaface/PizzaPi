import { expect, test } from "bun:test";
import { speechDetector, SPEECH_OPTIONS } from "./vad";

function setup(probability: (frame: Float32Array) => number = (f) => f[0]!) {
    const events: string[] = [];
    const clips: Float32Array[] = [];
    const detector = speechDetector({
        process: async (frame) => ({ isSpeech: probability(frame), notSpeech: 1 - probability(frame) }),
        reset_state() {}, release: async () => {},
    }, 16000, {
        start: () => events.push("start"), discard: () => events.push("discard"),
        end: (samples) => { events.push("end"); clips.push(samples); },
    });
    const feed = async (frames: number, value: number) => {
        for (let i = 0; i < frames; i++) await detector.process(new Float32Array(512).fill(value), () => true);
    };
    return { events, clips, detector, feed };
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
    const { feed, events, clips, detector } = setup();
    await feed(SPEECH_OPTIONS.minSpeechMs / 32, 0.95);
    expect(events).toEqual(["start"]);
    await feed(Math.floor(SPEECH_OPTIONS.redemptionMs / 32), 0);
    expect(events).toEqual(["start", "end"]);
    expect(clips[0]!.length).toBeGreaterThan(0);
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
