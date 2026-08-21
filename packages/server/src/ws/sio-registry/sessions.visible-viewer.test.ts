import { describe, expect, it, mock } from "bun:test";

/**
 * hasVisibleViewer decides whether a user's PHONE stays silent, so the
 * fail-open rule is worth pinning down: only an explicit `viewerVisible === true`
 * counts as "the user can see this". Unknown/undefined must NOT suppress.
 *
 * Guessing "visible" costs a silently dropped notification (the exact bug this
 * feature exists to fix); guessing "hidden" costs one redundant buzz.
 */

let fetchSocketsImpl: () => Promise<Array<{ data: unknown }>> = async () => [];
let withTimeoutImpl = <T>(promise: Promise<T>) => promise;

// Spread the real module and override only getIo — context.js has many other
// exports (hubUserRoom, etc.) that sibling modules import, and stubbing it
// wholesale breaks them at import time.
const actualContext = await import("./context.js");
mock.module("./context.js", () => ({
    ...actualContext,
    withTimeout: <T>(promise: Promise<T>) => withTimeoutImpl(promise),
    getIo: () => ({
        of: () => ({
            in: () => ({ fetchSockets: fetchSocketsImpl }),
        }),
    }),
}));

const { hasVisibleViewer } = await import("./sessions.js");

function sockets(...data: unknown[]): () => Promise<Array<{ data: unknown }>> {
    return async () => data.map((d) => ({ data: d }));
}

describe("hasVisibleViewer (fail-open)", () => {
    it("is true when a viewer explicitly reports visible", async () => {
        fetchSocketsImpl = sockets({ viewerVisible: true });
        expect(await hasVisibleViewer("s1")).toBe(true);
    });

    it("is false when a viewer explicitly reports hidden", async () => {
        fetchSocketsImpl = sockets({ viewerVisible: false });
        expect(await hasVisibleViewer("s1")).toBe(false);
    });

    it("is false when visibility was never reported (older client / pre-emit window)", async () => {
        fetchSocketsImpl = sockets({});
        expect(await hasVisibleViewer("s1")).toBe(false);
    });

    it("is false with no viewers at all", async () => {
        fetchSocketsImpl = sockets();
        expect(await hasVisibleViewer("s1")).toBe(false);
    });

    it("is true when any one of several viewers is visible", async () => {
        fetchSocketsImpl = sockets({ viewerVisible: false }, {}, { viewerVisible: true });
        expect(await hasVisibleViewer("s1")).toBe(true);
    });

    it("is false when the adapter throws \u2014 over-notify rather than drop", async () => {
        fetchSocketsImpl = async () => {
            throw new Error("adapter down");
        };
        expect(await hasVisibleViewer("s1")).toBe(false);
    });

    it("is false when the cluster lookup times out — over-notify rather than drop", async () => {
        fetchSocketsImpl = () => new Promise(() => {});
        withTimeoutImpl = async <T>(_promise: Promise<T>): Promise<T> => { throw new Error("timed out"); };
        expect(await hasVisibleViewer("s1")).toBe(false);
        withTimeoutImpl = <T>(promise: Promise<T>) => promise;
    });
});
