/**
 * Tests for IframeServicePanel src construction.
 *
 * happy-dom provides localStorage; we simulate mobile mode by pre-seeding
 * pizzapi.serverUrl and verify the iframe gets an absolute relay URL.
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

    test("uses relative tunnel URL in non-mobile mode", () => {
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess-123", port: 8080 }),
        );
        const src = extractSrc(container)!;
        const url = new URL(src, "http://localhost");
        expect(url.pathname).toBe("/api/tunnel/sess-123/8080/");
        expect(url.searchParams.get("sessionId")).toBe("sess-123");
    });

    test("escapes session id in tunnel path", () => {
        const { container } = render(
            React.createElement(IframeServicePanel, { sessionId: "sess with spaces", port: 8080 }),
        );
        const src = extractSrc(container);
        expect(src).toContain("/api/tunnel/sess%20with%20spaces/8080/");
    });

    test("appends panel params, session id, project dir, deep-link query and fragment", () => {
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
        const src = extractSrc(container)!;
        const url = new URL(src, "http://localhost");
        expect(url.pathname).toBe("/api/tunnel/sess-123/8080/");
        expect(url.searchParams.get("HOME")).toBe("/home/user");
        expect(url.searchParams.get("sessionId")).toBe("sess-123");
        expect(url.searchParams.get("projectDir")).toBe("/project");
        expect(url.searchParams.get("foo")).toBe("bar");
        expect(url.hash).toBe("#section");
    });

    test("uses token-authenticated relay URL in bundled mobile mode", async () => {
        localStorage.setItem("pizzapi.serverUrl", "https://relay.example.com");
        _setMobileRuntimeCache("key-123");
        globalThis.fetch = async (input, init) => {
            expect(String(input)).toBe("https://relay.example.com/api/tunnel-token");
            expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("key-123");
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
        globalThis.fetch = async () => new Response(JSON.stringify({ url: "/api/tunnel/auth/tok/sess-123/8080/" }), { status: 200 });
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
