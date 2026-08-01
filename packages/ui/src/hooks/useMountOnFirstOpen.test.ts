import { describe, expect, it, afterAll } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(globalThis as unknown as Record<string, unknown>).window = win;
(globalThis as unknown as Record<string, unknown>).document = win.document;
(globalThis as unknown as Record<string, unknown>).navigator = win.navigator;
(globalThis as unknown as Record<string, unknown>).localStorage = win.localStorage;
(globalThis as unknown as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as unknown as Record<string, unknown>).Element = win.Element;
(globalThis as unknown as Record<string, unknown>).Node = win.Node;
(globalThis as unknown as Record<string, unknown>).MutationObserver = win.MutationObserver;
(globalThis as unknown as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);

afterAll(() => {
  (globalThis as unknown as Record<string, unknown>).window = undefined;
  (globalThis as unknown as Record<string, unknown>).document = undefined;
});

const { renderHook, act } = await import("@testing-library/react");
const { useMountOnFirstOpen } = await import("./useMountOnFirstOpen");

describe("useMountOnFirstOpen", () => {
    it("starts mounted when initially open", () => {
        const { result } = renderHook(({ open }) => useMountOnFirstOpen(open), {
            initialProps: { open: true },
        });
        expect(result.current).toBe(true);
    });

    it("stays unmounted while closed", () => {
        const { result } = renderHook(({ open }) => useMountOnFirstOpen(open), {
            initialProps: { open: false },
        });
        expect(result.current).toBe(false);
    });

    it("mounts on first open", () => {
        const { result, rerender } = renderHook(({ open }) => useMountOnFirstOpen(open), {
            initialProps: { open: false },
        });
        expect(result.current).toBe(false);

        act(() => rerender({ open: true }));
        expect(result.current).toBe(true);
    });

    it("stays mounted after closing", () => {
        const { result, rerender } = renderHook(({ open }) => useMountOnFirstOpen(open), {
            initialProps: { open: false },
        });

        act(() => rerender({ open: true }));
        expect(result.current).toBe(true);

        act(() => rerender({ open: false }));
        expect(result.current).toBe(true);
    });

    it("remains mounted across repeated open/close cycles", () => {
        const { result, rerender } = renderHook(({ open }) => useMountOnFirstOpen(open), {
            initialProps: { open: false },
        });

        for (let i = 0; i < 3; i++) {
            act(() => rerender({ open: true }));
            expect(result.current).toBe(true);
            act(() => rerender({ open: false }));
            expect(result.current).toBe(true);
        }
    });
});
