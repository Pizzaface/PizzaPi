import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createLogger } from "./log.js";

describe("createLogger", () => {
    let logSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        logSpy = spyOn(console, "log").mockImplementation(() => {});
        warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        errorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    test("info() writes to console.log with timestamp and tag", () => {
        const log = createLogger("health");
        log.info("Redis connected");

        expect(logSpy).toHaveBeenCalledTimes(1);
        const [ts, tag, msg] = logSpy.mock.calls[0];
        expect(tag).toBe("[health]");
        expect(msg).toBe("Redis connected");
        // Timestamp should be ISO 8601
        expect(() => new Date(ts as string).toISOString()).not.toThrow();
    });

    test("warn() writes to console.warn with timestamp and tag", () => {
        const log = createLogger("sio/relay");
        log.warn("Degraded:", "ECONNRESET");

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [ts, tag, msg, extra] = warnSpy.mock.calls[0];
        expect(tag).toBe("[sio/relay]");
        expect(msg).toBe("Degraded:");
        expect(extra).toBe("ECONNRESET");
        expect(() => new Date(ts as string).toISOString()).not.toThrow();
    });

    test("error() writes to console.error with timestamp and tag", () => {
        const log = createLogger("startup");
        const err = new Error("boom");
        log.error("Failed:", err);

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [ts, tag, msg, errArg] = errorSpy.mock.calls[0];
        expect(tag).toBe("[startup]");
        expect(msg).toBe("Failed:");
        expect(errArg).toBe(err);
        expect(() => new Date(ts as string).toISOString()).not.toThrow();
    });

    test("passes through extra variadic args", () => {
        const log = createLogger("test");
        log.info("multi", 1, true, { key: "val" });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const args = logSpy.mock.calls[0];
        // [timestamp, "[test]", "multi", 1, true, { key: "val" }]
        expect(args.length).toBe(6);
        expect(args[3]).toBe(1);
        expect(args[4]).toBe(true);
        expect(args[5]).toEqual({ key: "val" });
    });

    test("different loggers have independent tags", () => {
        const a = createLogger("alpha");
        const b = createLogger("beta");
        a.info("hello");
        b.info("world");

        expect(logSpy.mock.calls[0][1]).toBe("[alpha]");
        expect(logSpy.mock.calls[1][1]).toBe("[beta]");
    });
});
