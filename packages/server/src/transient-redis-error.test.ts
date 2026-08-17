import { describe, expect, test } from "bun:test";
import { isTransientRedisError } from "./transient-redis-error.js";

function named(name: string, message = "x"): Error {
    const err = new Error(message);
    err.name = name;
    return err;
}

describe("isTransientRedisError", () => {
    test("matches node-redis connection error classes by name", () => {
        expect(isTransientRedisError(named("SocketClosedUnexpectedlyError"))).toBe(true);
        expect(isTransientRedisError(named("ConnectionTimeoutError"))).toBe(true);
        expect(isTransientRedisError(named("ClientClosedError"))).toBe(true);
        expect(isTransientRedisError(named("ClientOfflineError"))).toBe(true);
    });

    test("matches generic errors carrying the known messages", () => {
        expect(isTransientRedisError(new Error("Socket closed unexpectedly"))).toBe(true);
        expect(isTransientRedisError(new Error("Connection timeout"))).toBe(true);
    });

    test("does not match unrelated errors", () => {
        expect(isTransientRedisError(new Error("boom"))).toBe(false);
        expect(isTransientRedisError(named("TypeError", "x is not a function"))).toBe(false);
        expect(isTransientRedisError(named("RangeError"))).toBe(false);
    });
});
