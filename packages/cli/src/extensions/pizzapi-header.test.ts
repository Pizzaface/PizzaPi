/**
 * Tests for the PizzaPi branded TUI header extension.
 *
 * Uses a minimal Theme mock to test layout logic without needing
 * a real TUI or pi agent context.
 */

import { describe, test, expect } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";

// ── Minimal mock theme that returns plain text (no ANSI codes) ───────────────
// This makes it easy to check visible output without stripping escape codes.

type ThemeColor =
    | "accent"
    | "border"
    | "borderAccent"
    | "borderMuted"
    | "success"
    | "error"
    | "warning"
    | "muted"
    | "dim"
    | "text"
    | string;

const mockTheme = {
    fg: (_color: ThemeColor, text: string) => text,
    bold: (text: string) => text,
} as any;

// ── Import pure helpers by re-implementing them for isolated test ─────────────
// We test the exported `pizzapiHeaderExtension` function indirectly by
// verifying observable render output through mock session_start registration.
// For pure logic, we directly test the render path by calling ctx.ui.setHeader.

// We capture the render function by hijacking the setHeader call.
let capturedRender: ((width: number) => string[]) | null = null;

const mockCtx = {
    ui: {
        setHeader: (factory: (tui: any, theme: any) => { render: (w: number) => string[]; invalidate: () => void }) => {
            const component = factory({}, mockTheme);
            capturedRender = component.render.bind(component);
        },
    },
};

const mockPi = {
    on: (event: string, handler: (ev: any, ctx: any) => void) => {
        if (event === "session_start") {
            handler({}, mockCtx);
        }
    },
} as any;

import { pizzapiHeaderExtension } from "./pizzapi-header.js";

describe("pizzapiHeaderExtension", () => {
    test("registers on session_start and calls setHeader", () => {
        capturedRender = null;
        pizzapiHeaderExtension(mockPi);
        expect(capturedRender).not.toBeNull();
    });

    test("render returns string array", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        expect(Array.isArray(lines)).toBe(true);
        expect(lines.length).toBeGreaterThan(0);
    });

    test("wide render (>= 100 cols) returns 7 lines with box-drawing frame", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        // Wide mode: top border + row1 + separator + row2 + row3 + row4 + bottom border = 7
        expect(lines.length).toBe(7);
    });

    test("narrow render (< 100 cols) returns single compact line", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(60);
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain("🍕");
        expect(lines[0]).toContain("PizzaPi");
    });

    test("width=99 is narrow (< 100 threshold)", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(99);
        expect(lines.length).toBe(1);
    });

    test("width=100 is wide (>= 100 threshold)", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        expect(lines.length).toBe(7);
    });

    test("narrow mode: line visible width does not exceed given width", () => {
        pizzapiHeaderExtension(mockPi);
        for (const width of [5, 10, 17, 20, 40, 60, 80, 99]) {
            const lines = capturedRender!(width);
            for (const line of lines) {
                const lw = visibleWidth(line!);
                expect(lw).toBeLessThanOrEqual(width);
            }
        }
    });

    test("wide mode: all lines visible width does not exceed given width", () => {
        pizzapiHeaderExtension(mockPi);
        for (const width of [100, 120, 160, 200]) {
            const lines = capturedRender!(width);
            for (const line of lines) {
                const lw = visibleWidth(line!);
                expect(lw).toBeLessThanOrEqual(width);
            }
        }
    });

    test("wide top border contains PizzaPi branding", () => {
        pizzapiHeaderExtension(mockPi);
        const [topBorder] = capturedRender!(100);
        expect(topBorder).toContain("PizzaPi");
        expect(topBorder).toContain("🍕");
    });

    test("wide top border starts with ╭ and ends with ╮", () => {
        pizzapiHeaderExtension(mockPi);
        const [topBorder] = capturedRender!(100);
        expect(topBorder!.startsWith("╭")).toBe(true);
        expect(topBorder!.endsWith("╮")).toBe(true);
    });

    test("wide bottom border starts with ╰ and ends with ╯", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const bottom = lines[lines.length - 1]!;
        expect(bottom.startsWith("╰")).toBe(true);
        expect(bottom.endsWith("╯")).toBe(true);
    });

    test("content lines start with │ and end with │", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        // Content lines are indices 1 and 3-5 (not top, mid-separator, bottom borders)
        const contentLines = [lines[1], lines[3], lines[4], lines[5]];
        for (const line of contentLines) {
            expect(line!.startsWith("│")).toBe(true);
            expect(line!.endsWith("│")).toBe(true);
        }
    });

    test("mid-separator starts with ├ and ends with ┤", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const mid = lines[2]!;
        expect(mid.startsWith("├")).toBe(true);
        expect(mid.endsWith("┤")).toBe(true);
    });

    test("all wide lines have consistent visible width", () => {
        pizzapiHeaderExtension(mockPi);
        const width = 100;
        const lines = capturedRender!(width);
        // Each line should be exactly width chars (no ANSI in mock theme)
        for (const line of lines) {
            // Allow for emoji width variation (🍕 may be 2 wide)
            // but check they're close to the target width
            expect(line!.length).toBeGreaterThanOrEqual(width - 5);
            expect(line!.length).toBeLessThanOrEqual(width + 5);
        }
    });

    test("row1 contains key bindings for basic controls", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const row1 = lines[1]!;
        expect(row1).toContain("Ctrl+C");
        expect(row1).toContain("Ctrl+D");
        expect(row1).toContain("Ctrl+Z");
    });

    test("row2 contains thinking and model hints", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const row2 = lines[3]!;
        expect(row2).toContain("⇧Tab");
        expect(row2).toContain("Ctrl+L");
    });

    test("row3 contains tools and editor hints", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const row3 = lines[4]!;
        expect(row3).toContain("Ctrl+O");
        expect(row3).toContain("Ctrl+G");
    });

    test("row4 contains special input hints", () => {
        pizzapiHeaderExtension(mockPi);
        const lines = capturedRender!(100);
        const row4 = lines[5]!;
        expect(row4).toContain("/");
        expect(row4).toContain("!");
        expect(row4).toContain("Ctrl+V");
    });

    test("handles very narrow width gracefully (width < 10)", () => {
        pizzapiHeaderExtension(mockPi);
        // Should not throw
        expect(() => capturedRender!(5)).not.toThrow();
        const lines = capturedRender!(5);
        expect(Array.isArray(lines)).toBe(true);
    });
});
