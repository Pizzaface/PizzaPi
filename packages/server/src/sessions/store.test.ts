import { describe, it, expect, afterEach } from "bun:test";
import { getEphemeralSweepIntervalMs, getEphemeralTtlMs } from "./store.js";

describe("store.ts", () => {
    describe("getEphemeralSweepIntervalMs", () => {
        const ORIGINAL_ENV = process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;

        afterEach(() => {
            if (ORIGINAL_ENV === undefined) {
                delete process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;
            } else {
                process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = ORIGINAL_ENV;
            }
        });

        it("should return the default value when env var is not set", () => {
            delete process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the parsed value when env var is a valid positive integer", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "120000";
            expect(getEphemeralSweepIntervalMs()).toBe(120000);
        });

        it("should return the default value when env var is zero", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "0";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is a negative integer", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "-5000";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is not a number", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "abc";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is an empty string", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });
    });

    describe("getEphemeralTtlMs", () => {
        const ORIGINAL_ENV = process.env.PIZZAPI_EPHEMERAL_TTL_MS;

        afterEach(() => {
            if (ORIGINAL_ENV === undefined) {
                delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            } else {
                process.env.PIZZAPI_EPHEMERAL_TTL_MS = ORIGINAL_ENV;
            }
        });

        it("should return the default value when env var is not set", () => {
            delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the parsed value when env var is a valid positive integer", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "300000";
            expect(getEphemeralTtlMs()).toBe(300000);
        });

        it("should return the default value when env var is zero", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "0";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is a negative integer", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "-10000";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is not a number", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "invalid";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is an empty string", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });
    });
});
