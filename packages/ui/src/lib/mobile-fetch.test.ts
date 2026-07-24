/**
 * Tests for the mobile fetch patch:
 *  - x-api-key is injected only for same-origin (relay) requests, never leaked
 *    to third-party absolute URLs.
 *  - Request inputs are rebuilt against the resolved URL, preserving method,
 *    headers, and body (spreading a Request drops all of these).
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Window } from "happy-dom";

const SERVER_URL = "https://relay.example.com";

// Real happy-dom window + real mobile-runtime (no mock.module — a process-global
// module mock leaks into every other test file in the run and strips the real
// module's other exports). mobile-fetch captures window.fetch at import time, so
// the recording stub must be installed on the window BEFORE the dynamic import.
let calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const win = new Window({ url: "https://localhost/" });
(win as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("ok"));
}) as typeof fetch;
// Install the FULL, consistent DOM global set from one Window. These files set
// globals at module top-level, so the last-loaded file wins process-wide; a
// partial set (window without a matching document) makes react-dom crash every
// render test that happens to run afterwards. Mirror the canonical render-test
// setup so this file can never poison another.
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).localStorage = win.localStorage;

const { patchedFetch } = await import("./mobile-fetch.js");
const { _setMobileRuntimeCache, _resetMobileRuntimeCache } = await import("./mobile-runtime.js");

/** Put the real mobile-runtime into bundled mode with a cached API key. */
function seedMobile(): void {
    localStorage.setItem("pizzapi.serverUrl", SERVER_URL);
    _setMobileRuntimeCache("secret-key");
}

/** Resolve the forwarded request into a normalized shape for assertions. */
async function forwarded(): Promise<{ url: string; method: string; apiKey: string | null; contentType: string | null; body: string }> {
    const { input, init } = calls[0];
    if (input instanceof Request) {
        return {
            url: input.url,
            method: input.method,
            apiKey: input.headers.get("x-api-key"),
            contentType: input.headers.get("content-type"),
            body: input.body ? await input.text() : "",
        };
    }
    const headers = new Headers(init?.headers);
    return {
        url: String(input),
        method: init?.method ?? "GET",
        apiKey: headers.get("x-api-key"),
        contentType: headers.get("content-type"),
        body: typeof init?.body === "string" ? init.body : "",
    };
}

beforeEach(() => {
    calls = [];
    localStorage.clear();
    _resetMobileRuntimeCache();
    seedMobile();
});

// ponytail: bun shares globalThis across test files, so leaving
// pizzapi.serverUrl set puts every later file into "mobile bundled" mode.
afterAll(() => {
    localStorage.clear();
    _resetMobileRuntimeCache();
});

describe("patchedFetch — api key gating", () => {
    test("adds x-api-key for relative paths (rewritten to relay)", async () => {
        await patchedFetch("/api/sessions");
        const f = await forwarded();
        expect(f.url).toBe(`${SERVER_URL}/api/sessions`);
        expect(f.apiKey).toBe("secret-key");
    });

    test("adds x-api-key for absolute URLs that target the relay", async () => {
        await patchedFetch(`${SERVER_URL}/api/thing`);
        expect((await forwarded()).apiKey).toBe("secret-key");
    });

    test("does NOT leak x-api-key to third-party absolute URLs", async () => {
        await patchedFetch("https://evil.example.com/steal");
        const f = await forwarded();
        expect(f.url).toBe("https://evil.example.com/steal");
        expect(f.apiKey).toBeNull();
    });

    test("does not touch requests when not mobile-bundled", async () => {
        // No serverUrl → isMobileBundled is false → pass-through.
        localStorage.removeItem("pizzapi.serverUrl");
        _resetMobileRuntimeCache();
        await patchedFetch("/api/sessions");
        const f = await forwarded();
        // Pass-through: relative path unchanged, no key.
        expect(f.url).toBe("/api/sessions");
        expect(f.apiKey).toBeNull();
    });
});

describe("patchedFetch — Request reconstruction", () => {
    // In a real browser a Request built from a relative path already has an
    // absolute `.url` (resolved against the bundle/relay origin), so tests use
    // absolute URLs here.
    test("preserves method, headers, and body for a Request input", async () => {
        const req = new Request(`${SERVER_URL}/api/upload`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-custom": "1" },
            body: JSON.stringify({ hello: "world" }),
        });
        await patchedFetch(req);
        const f = await forwarded();
        expect(f.url).toBe(`${SERVER_URL}/api/upload`);
        expect(f.method).toBe("POST");
        expect(f.contentType).toBe("application/json");
        expect(f.apiKey).toBe("secret-key");
        expect(f.body).toBe(JSON.stringify({ hello: "world" }));

        const req2 = calls[0].input as Request;
        expect(req2.headers.get("x-custom")).toBe("1");
    });

    test("does not leak the key for a cross-origin Request input", async () => {
        const req = new Request("https://evil.example.com/steal", { method: "POST", body: "x" });
        await patchedFetch(req);
        const f = await forwarded();
        expect(f.url).toBe("https://evil.example.com/steal");
        expect(f.method).toBe("POST");
        expect(f.apiKey).toBeNull();
    });
});
