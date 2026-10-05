/**
 * Tests for IframeServicePanel src construction.
 *
 * happy-dom provides localStorage; we simulate mobile mode by pre-seeding
 * pizzapi.serverUrl and verify the iframe gets an absolute relay URL. Web and
 * mobile both mint: runner content must never load on the relay origin with
 * same-origin privileges (no relative cookie-path fallback).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).localStorage = win.localStorage;

const { IframeServicePanel } = await import("./IframeServicePanel");
const { _resetMobileRuntimeCache, _setMobileRuntimeCache } = await import("../../lib/mobile-runtime.js");

function extractSrc(container: HTMLElement): string | null {
    const iframe = container.querySelector("iframe");
    return iframe?.getAttribute("src") ?? null;
}

describe("IframeServicePanel", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        localStorage.clear();
        _resetMobileRuntimeCache();
        globalThis.fetch = originalFetch;
    });

    afterEach(() => {
        cleanup();
        document.body.innerHTML = "";
        localStorage.clear();
        _resetMobileRuntimeCache();
        globalThis.fetch = originalFetch;
    });

    type MintBody = { sessionId?: string; runnerId?: string; port: number; ttlHours?: number };
    function mockMint(response: (body: MintBody) => Record<string, unknown>, calls: MintBody[] = []) {
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
            expect(String(input)).toBe("/api/tunnel-token");
            const body = JSON.parse(String(init?.body)) as MintBody;
            calls.push(body);
            return new Response(JSON.stringify(response(body)), { status: 200 });
        }) as typeof fetch;
        return calls;
    }

    async function renderedIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
        await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
        return container.querySelector("iframe") as unknown as HTMLIFrameElement;
    }

    test("web: mints a signed relay path and sandboxes it without same-origin privileges", async () => {
        const calls = mockMint(() => ({ url: "/api/tunnel/auth/tok/sess-123/8080/" }));
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        const iframe = await renderedIframe(container);
        const url = new URL(iframe.getAttribute("src")!, "http://localhost");
        expect(url.pathname).toBe("/api/tunnel/auth/tok/sess-123/8080/");
        expect(url.searchParams.get("sessionId")).toBe("sess-123");
        expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
        expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
        expect(calls).toEqual([{ sessionId: "sess-123", port: 8080, ttlHours: 24 }]);
    });

    test("web: never falls back to the cookie-authenticated relay path when minting fails", async () => {
        globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        await waitFor(() => expect(container.textContent).toContain("Could not open panel"));
        expect(container.querySelector("iframe")).toBeNull();
    });

    test("web: rejects a mint response that is not a signed tunnel path", async () => {
        mockMint(() => ({ url: "/api/tunnel/sess-123/8080/" }));
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        await waitFor(() => expect(container.textContent).toContain("Could not open panel"));
        expect(container.querySelector("iframe")).toBeNull();
    });

    test("isolated tunnel origin keeps same-origin privileges (it is not the relay origin)", async () => {
        mockMint(() => ({ url: "/api/tunnel/auth/tok/sess-123/8080/", hostUrl: "http://abc123.t.localhost:7492/" }));
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        const iframe = await renderedIframe(container);
        expect(iframe.getAttribute("src")).toStartWith("http://abc123.t.localhost:7492/?");
        expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
    });

    test("appends panel params, session id, project dir, deep-link query and fragment", async () => {
        mockMint(() => ({ url: "/api/tunnel/auth/tok/sess-123/8080/" }));
        const { container } = render(
            React.createElement(IframeServicePanel, {
                sessionId: "sess-123",
                port: 8080,
                panelParams: { HOME: "/home/user" },
                cwd: "/project",
                query: "foo=bar",
                fragment: "section",
            }),
        );
        const iframe = await renderedIframe(container);
        const url = new URL(iframe.getAttribute("src")!, "http://localhost");
        expect(url.pathname).toBe("/api/tunnel/auth/tok/sess-123/8080/");
        expect(url.searchParams.get("HOME")).toBe("/home/user");
        expect(url.searchParams.get("sessionId")).toBe("sess-123");
        expect(url.searchParams.get("projectDir")).toBe("/project");
        expect(url.searchParams.get("foo")).toBe("bar");
        expect(url.hash).toBe("#section");
    });

    test("runner-scoped tunnel mints runner-scoped and drops the empty sessionId param", async () => {
        const calls = mockMint(() => ({ url: "/api/tunnel/auth/tok/runner%3Arunner-abc/8080/" }));
        const { container } = render(
            React.createElement(IframeServicePanel, {
                sessionId: "",
                runnerId: "runner-abc",
                port: 8080,
                panelParams: { sessionId: "" },
            }),
        );
        const iframe = await renderedIframe(container);
        const url = new URL(iframe.getAttribute("src")!, "http://localhost");
        expect(url.searchParams.has("sessionId")).toBe(false);
        expect(url.searchParams.get("runnerId")).toBe("runner-abc");
        expect(calls[0]).toEqual({ runnerId: "runner-abc", port: 8080, ttlHours: 24 });
    });

    test("uses token-authenticated relay URL in bundled mobile mode", async () => {
        localStorage.setItem("pizzapi.serverUrl", "https://relay.example.com");
        _setMobileRuntimeCache("key-123");
        globalThis.fetch = async (input, init) => {
            expect(String(input)).toBe("https://relay.example.com/api/tunnel-token");
            expect(((init?.headers as Record<string, string>) ?? {})["x-api-key"]).toBe("key-123");
            return new Response(JSON.stringify({ url: "/api/tunnel/auth/tok/sess-123/8080/" }), { status: 200 });
        };
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        await waitFor(() => expect(extractSrc(container)).not.toBeNull());
        const src = extractSrc(container)!;
        expect(src).toStartWith("https://relay.example.com/api/tunnel/auth/tok/sess-123/8080/");
        expect(new URL(src).searchParams.get("sessionId")).toBe("sess-123");
    });

    test("preserves token base when appending query params in mobile mode", async () => {
        localStorage.setItem("pizzapi.serverUrl", "https://relay.example.com");
        // A *.localhost tunnel origin resolves to the phone itself — skip it.
        globalThis.fetch = async () => new Response(JSON.stringify({ url: "/api/tunnel/auth/tok/sess-123/8080/", hostUrl: "http://abc.t.localhost:7492/" }), { status: 200 });
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080, cwd: "/project" }),
        );
        await waitFor(() => expect(extractSrc(container)).not.toBeNull());
        const src = extractSrc(container)!;
        expect(src).toStartWith("https://relay.example.com/api/tunnel/auth/tok/sess-123/8080/");
        expect(src).toContain("?");
        expect(src).toContain("projectDir=%2Fproject");
    });
});
