import { afterAll, describe, expect, test } from "bun:test";
import {
    isServerShuttingDown,
    setServerShuttingDown,
    resetServerShuttingDown,
    shouldPreserveOnSocketDisconnect,
} from "./health.js";

describe("server health — shutdown flag", () => {
    // Always reset after this suite so the module-level flag doesn't leak
    // into other test files sharing the same Bun process.
    afterAll(() => {
        resetServerShuttingDown();
    });

    test("isServerShuttingDown is false by default", () => {
        expect(isServerShuttingDown).toBe(false);
    });

    test("setServerShuttingDown sets the flag to true", () => {
        setServerShuttingDown();
        expect(isServerShuttingDown).toBe(true);
    });

    test("resetServerShuttingDown resets the flag to false", () => {
        // Flag is still true from previous test
        expect(isServerShuttingDown).toBe(true);
        resetServerShuttingDown();
        expect(isServerShuttingDown).toBe(false);
    });

    test("shouldPreserveOnSocketDisconnect follows shutdown flag", () => {
        resetServerShuttingDown();
        expect(shouldPreserveOnSocketDisconnect("transport close")).toBe(false);

        setServerShuttingDown();
        expect(shouldPreserveOnSocketDisconnect("transport close")).toBe(true);
        expect(shouldPreserveOnSocketDisconnect("server shutting down")).toBe(true);
    });
});
