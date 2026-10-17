import { expect, test } from "bun:test";
import { rms, toPcm16 } from "./audio";

test("toPcm16 is little-endian and clamped", () => {
    const pcm = new DataView(toPcm16(new Float32Array([0, 1, -1, 2])));
    expect(pcm.byteLength).toBe(8);
    expect([pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true), pcm.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
});

test("rms", () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0]))).toBe(0);
});
