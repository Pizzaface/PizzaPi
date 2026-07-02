import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";

mock.module("@/lib/utils", () => ({
    cn: (...classes: Array<string | undefined | null | false>) => classes.filter(Boolean).join(" "),
}));

mock.module("@/components/ui/card", () => ({
    Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

mock.module("@/components/ui/button", () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

const fetchMock = mock();

const toDataURLMock = mock();
mock.module("qrcode", () => ({
    default: { toDataURL: toDataURLMock },
}));

const { MobileSetupQR } = await import("./MobileSetupQR");

beforeAll(() => {
    const win = new Window({ url: "https://relay.example.com/" });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (win as any).SyntaxError = SyntaxError;
    (globalThis as any).window = win;
    (globalThis as any).document = win.document;
    (globalThis as any).navigator = win.navigator;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).Element = win.Element;
    (globalThis as any).Node = win.Node;
    (globalThis as any).SVGElement = win.SVGElement;
    (globalThis as any).Event = win.Event;
    (globalThis as any).MouseEvent = win.MouseEvent;
    (globalThis as any).MutationObserver = (win as any).MutationObserver;
    (globalThis as any).fetch = fetchMock;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    toDataURLMock.mockReset();
});

afterAll(() => mock.restore());

describe("MobileSetupQR", () => {
    test("creates a mobile link and renders its QR URL", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ id: "link123", status: "pending", relayUrl: "https://relay.example.com", expiresAt: "2026-06-25T12:10:00.000Z" }),
        });
        toDataURLMock.mockResolvedValue("data:image/png;base64,qr");

        const { container } = render(<MobileSetupQR />);

        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,qr"));
        expect(fetchMock).toHaveBeenCalledWith("/api/mobile-link", {
            method: "POST",
            body: JSON.stringify({ relayUrl: "https://relay.example.com" }),
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
        });
        expect(toDataURLMock).toHaveBeenCalledWith(
            "https://relay.example.com/mobile-link?id=link123",
            expect.any(Object),
        );
    });
});
