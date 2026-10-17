import { expect, test } from "bun:test";
import { randomPitchRate } from "./cues";

test("waiting synth pitch stays within ±2 whole semitones", () => {
    const rates = [0, 0.2, 0.4, 0.6, 0.8, 0.9999].map((r) => randomPitchRate(() => r));
    expect(rates.map((r) => Math.round(12 * Math.log2(r)))).toEqual([-2, -1, 0, 1, 2, 2]);
});
