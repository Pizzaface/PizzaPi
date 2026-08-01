import { describe, expect, it } from "bun:test";
import { shouldReloadOnChunkError } from "./chunk-reload.js";

function memStorage(initial?: string) {
    const map = new Map<string, string>();
    if (initial) map.set("pizzapi:chunk-reload", initial);
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
    };
}

describe("shouldReloadOnChunkError", () => {
    it("reloads on first failure and records the attempt", () => {
        const s = memStorage();
        expect(shouldReloadOnChunkError(s, 1_000_000)).toBe(true);
        expect(s.getItem("pizzapi:chunk-reload")).toBe("1000000");
    });

    it("does not loop while within the cooldown", () => {
        const s = memStorage();
        shouldReloadOnChunkError(s, 1_000_000);
        expect(shouldReloadOnChunkError(s, 1_005_000)).toBe(false);
        expect(shouldReloadOnChunkError(s, 1_040_000)).toBe(true);
    });

    it("does not reload when storage is unavailable", () => {
        const throwing = {
            getItem: () => { throw new Error("blocked"); },
            setItem: () => { throw new Error("blocked"); },
        };
        expect(shouldReloadOnChunkError(throwing, 1_000_000)).toBe(false);
    });
});
