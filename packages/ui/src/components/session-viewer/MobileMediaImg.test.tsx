/**
 * MobileMediaImg must never fall back to a URL carrying the durable API key:
 * a failed token mint shows an error with a retry, and retry re-mints.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { MobileMediaImg } = await import("./MobileMediaImg");
const { _resetMobileRuntimeCache, _setMobileRuntimeCache } = await import("@/lib/mobile-runtime");

const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as any).localStorage;

function useMobileServer(serverUrl: string | null) {
    Object.defineProperty(globalThis, "localStorage", {
        value: {
            getItem: (key: string) => (key === "pizzapi.serverUrl" ? serverUrl : null),
            setItem: () => {},
            removeItem: () => {},
        },
        configurable: true,
        writable: true,
    });
}

beforeEach(() => {
    _resetMobileRuntimeCache();
    _setMobileRuntimeCache("durable-secret-key");
});

afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
    _resetMobileRuntimeCache();
});

describe("MobileMediaImg", () => {
    test("on web renders the path directly without minting", () => {
        useMobileServer(null);
        let calls = 0;
        globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
        const { container } = render(<MobileMediaImg url="/api/attachments/a1" alt="Attachment" />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/a1");
        expect(calls).toBe(0);
    });

    test("shows an error (no apiKey URL) when minting fails, and retry re-mints the scoped token", async () => {
        useMobileServer("https://relay.example.com");
        let calls = 0;
        globalThis.fetch = (async () => {
            calls++;
            if (calls === 1) throw new Error("offline");
            return new Response(JSON.stringify({ token: "tok-xyz" }), { status: 200 });
        }) as unknown as typeof fetch;

        const view = render(<MobileMediaImg url="/api/attachments/a1" alt="Attachment" />);
        const alert = await waitFor(() => {
            const el = view.container.querySelector("[role=alert]");
            if (!el) throw new Error("no alert yet");
            return el;
        });
        expect(view.container.querySelector("img")).toBeNull();
        expect(view.container.innerHTML).not.toContain("durable-secret-key");
        expect(view.container.innerHTML).not.toContain("apiKey");

        fireEvent.click(alert.querySelector("button")!);
        const img = await waitFor(() => {
            const el = view.container.querySelector("img");
            if (!el) throw new Error("no img yet");
            return el;
        });
        expect(calls).toBe(2);
        expect(img.getAttribute("src")).toBe("https://relay.example.com/api/attachments/a1?token=tok-xyz");
    });

    test("shows an error when the token endpoint returns non-OK", async () => {
        useMobileServer("https://relay.example.com");
        globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;

        const view = render(<MobileMediaImg url="/api/attachments/a1" alt="Attachment" />);
        await waitFor(() => {
            if (!view.container.querySelector("[role=alert]")) throw new Error("no alert yet");
        });
        expect(view.container.querySelector("img")).toBeNull();
        expect(view.container.innerHTML).not.toContain("durable-secret-key");
    });
});
