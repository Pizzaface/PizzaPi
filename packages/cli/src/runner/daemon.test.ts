import { describe, expect, test } from "bun:test";
import { initServiceHandlers } from "./daemon.js";
import type { ServiceHandler, ServiceInitOptions } from "./service-handler.js";
import type { Socket } from "socket.io-client";

function makeSocket(): Socket {
    return {} as Socket;
}

function makeOpts(): ServiceInitOptions {
    return { isShuttingDown: () => false };
}

describe("initServiceHandlers", () => {
    test("initializes all handlers and tracks ids", () => {
        const initialized = new Set<string>();
        const handlers: ServiceHandler[] = [
            { id: "a", init: () => {}, dispose: () => {} },
            { id: "b", init: () => {}, dispose: () => {} },
        ];

        const result = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);

        expect(result.initialized).toEqual(["a", "b"]);
        expect(result.failed).toEqual([]);
        expect(Array.from(initialized)).toEqual(["a", "b"]);
    });

    test("continues past a throwing handler and retries it on the next call", () => {
        const initialized = new Set<string>();
        const calls: string[] = [];
        let throwCount = 0;
        const handlers: ServiceHandler[] = [
            {
                id: "ok",
                init: () => {
                    calls.push("ok");
                },
                dispose: () => {},
            },
            {
                id: "throws-once",
                init: () => {
                    calls.push("throws-once");
                    if (throwCount++ === 0) {
                        throw new Error("boom");
                    }
                },
                dispose: () => {},
            },
            {
                id: "after",
                init: () => {
                    calls.push("after");
                },
                dispose: () => {},
            },
        ];

        const first = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(first.initialized).toEqual(["ok", "after"]);
        expect(first.failed).toEqual(["throws-once"]);
        expect(calls).toEqual(["ok", "throws-once", "after"]);

        // On a second call, the previously successful handlers are skipped and
        // the failed handler is retried.
        const second = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(second.initialized).toEqual(["throws-once"]);
        expect(second.failed).toEqual([]);
        expect(Array.from(initialized)).toEqual(["ok", "after", "throws-once"]);
    });

    test("skips already-initialized handlers", () => {
        const initialized = new Set<string>(["skip"]);
        let called = false;
        const handlers: ServiceHandler[] = [
            {
                id: "skip",
                init: () => {
                    called = true;
                },
                dispose: () => {},
            },
        ];

        const result = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(result.initialized).toEqual([]);
        expect(called).toBe(false);
    });
});
