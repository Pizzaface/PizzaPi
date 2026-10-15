import { expect, test } from "bun:test";
import { encodeWav, rms } from "./audio";

test("encodeWav header + clamping", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 48000));
    expect(wav.byteLength).toBe(52);
    expect(wav.getUint32(24, true)).toBe(48000);
    expect([wav.getInt16(44, true), wav.getInt16(46, true), wav.getInt16(48, true), wav.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
});

test("rms", () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0]))).toBe(0);
});
