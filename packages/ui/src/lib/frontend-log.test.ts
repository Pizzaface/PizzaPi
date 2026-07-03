import { describe, expect, test, beforeEach } from "bun:test";
import {
    reportError,
    reportWarning,
    logFrontendEvent,
    getFrontendLog,
    clearFrontendLog,
    subscribeToast,
    subscribeFrontendLog,
} from "./frontend-log.js";

describe("frontend-log", () => {
    beforeEach(() => clearFrontendLog());

    test("reportError logs an entry and emits a toast by default", () => {
        const toasts: { message: string; type: string }[] = [];
        const off = subscribeToast((t) => toasts.push(t));
        reportError("tunnel", "boom", { detail: "port 3000" });
        off();

        const log = getFrontendLog();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ scope: "tunnel", level: "error", message: "boom", detail: "port 3000" });
        expect(toasts).toEqual([{ message: "boom", type: "error" }]);
    });

    test("toast:false logs without a toast", () => {
        const toasts: unknown[] = [];
        const off = subscribeToast((t) => toasts.push(t));
        reportError("bg", "quiet", { toast: false });
        off();
        expect(getFrontendLog()).toHaveLength(1);
        expect(toasts).toHaveLength(0);
    });

    test("reportWarning only toasts when asked", () => {
        const toasts: unknown[] = [];
        const off = subscribeToast((t) => toasts.push(t));
        reportWarning("x", "meh");
        reportWarning("x", "look", { toast: true });
        off();
        expect(getFrontendLog()).toHaveLength(2);
        expect(toasts).toHaveLength(1);
    });

    test("ring buffer caps entries at 500 (drops oldest)", () => {
        for (let i = 0; i < 520; i++) logFrontendEvent("loop", "info", `m${i}`);
        const log = getFrontendLog();
        expect(log).toHaveLength(500);
        expect(log[0].message).toBe("m20"); // oldest 20 dropped
        expect(log[log.length - 1].message).toBe("m519");
    });

    test("subscribers are notified and can unsubscribe", () => {
        let calls = 0;
        const off = subscribeFrontendLog(() => calls++);
        logFrontendEvent("s", "info", "a");
        expect(calls).toBe(1);
        off();
        logFrontendEvent("s", "info", "b");
        expect(calls).toBe(1);
    });
});
