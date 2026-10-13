import { describe, expect, test } from "bun:test";
import { encodeWav, EnergyVad, rms } from "./audio";

const run = (vad: EnergyVad, levels: number[], strict = false) => levels.map((l) => vad.feed(l, strict)?.type ?? null).filter(Boolean);

describe("EnergyVad", () => {
    test("start after sustained voice, end after silence", () => {
        const vad = new EnergyVad(50);
        const quiet = Array(20).fill(0.003);
        const talk = Array(20).fill(0.1);
        expect(run(vad, [...quiet, ...talk, ...Array(20).fill(0.003)])).toEqual(["start", "end"]);
    });
    test("short blips are discarded, single spikes ignored", () => {
        const vad = new EnergyVad(50);
        expect(run(vad, [0.003, 0.2, 0.003, 0.003])).toEqual([]);
        expect(run(vad, [0.2, 0.2, 0.2, ...Array(20).fill(0.003)])).toEqual(["start", "discard"]);
    });
    test("strict mode (TTS playing) ignores moderate echo", () => {
        const vad = new EnergyVad(50);
        expect(run(vad, Array(10).fill(0.02), true)).toEqual([]);
        expect(run(vad, Array(10).fill(0.02), false)).toEqual(["start"]);
    });
    test("noise floor adapts to a loud room", () => {
        const vad = new EnergyVad(50);
        run(vad, Array(200).fill(0.012));
        expect(vad.floor).toBeGreaterThan(0.01);
        expect(run(vad, Array(10).fill(0.02))).toEqual([]); // below 3x floor
    });
});

test("encodeWav header + clamping", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 48000));
    expect(wav.byteLength).toBe(52);
    expect(wav.getUint32(24, true)).toBe(48000);
    expect([wav.getInt16(44, true), wav.getInt16(46, true), wav.getInt16(48, true), wav.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
});

test("rms", () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
});
