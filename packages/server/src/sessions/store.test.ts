import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getEphemeralTtlMs } from "./store.js";

const DEFAULT_EPHEMERAL_TTL_MS = 10 * 60 * 1000;

describe("sessions/store", () => {
    describe("getEphemeralTtlMs", () => {
        let originalEnvVar: string | undefined;

        beforeEach(() => {
            originalEnvVar = process.env.PIZZAPI_EPHEMERAL_TTL_MS;
        });

        afterEach(() => {
            if (originalEnvVar === undefined) {
                delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            } else {
                process.env.PIZZAPI_EPHEMERAL_TTL_MS = originalEnvVar;
            }
        });

        test("returns default value when env var is not set", () => {
            delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            expect(getEphemeralTtlMs()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
        });

        test("returns parsed value when env var is a valid positive integer", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "5000";
            expect(getEphemeralTtlMs()).toBe(5000);
        });

        test("returns default value when env var is zero", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "0";
            expect(getEphemeralTtlMs()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
        });

        test("returns default value when env var is a negative number", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "-1000";
            expect(getEphemeralTtlMs()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
        });

        test("returns default value when env var is a non-numeric string", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "abc";
            expect(getEphemeralTtlMs()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
        });

        test("returns parsed value when env var is a float (truncates to int)", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "5000.5";
            expect(getEphemeralTtlMs()).toBe(5000);
        });

        test("returns default value when env var is an empty string", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "";
            expect(getEphemeralTtlMs()).toBe(DEFAULT_EPHEMERAL_TTL_MS);
        });
    });
});
