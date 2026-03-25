import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// We test the module behaviour by controlling the TTY + env state before import.
// Because Bun caches modules we use dynamic imports with cache-busting.

describe("cli-colors (NO_COLOR / non-TTY)", () => {
    // Strip ANSI escape sequences from a string
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    test("usageBar returns plain text when NO_COLOR is set", async () => {
        const orig = process.env["NO_COLOR"];
        process.env["NO_COLOR"] = "1";
        try {
            // Re-import so the module re-evaluates isColorEnabled
            const mod = await import(`./cli-colors.ts?nocolor=${Date.now()}`);
            const result = mod.usageBar(75);
            // Should not contain ANSI codes
            expect(result).toBe(stripAnsi(result));
            expect(result).toContain("75.0%");
            expect(result).toContain("[");
            expect(result).toContain("]");
        } finally {
            if (orig === undefined) delete process.env["NO_COLOR"];
            else process.env["NO_COLOR"] = orig;
        }
    });

    test("colorPct returns plain percentage string when NO_COLOR is set", async () => {
        const orig = process.env["NO_COLOR"];
        process.env["NO_COLOR"] = "1";
        try {
            const mod = await import(`./cli-colors.ts?nocolor2=${Date.now()}`);
            expect(mod.colorPct(42)).toBe("42.0%");
            expect(mod.colorPct(60)).toBe("60.0%");
            expect(mod.colorPct(90)).toBe("90.0%");
        } finally {
            if (orig === undefined) delete process.env["NO_COLOR"];
            else process.env["NO_COLOR"] = orig;
        }
    });
});

describe("cli-colors helpers (logic)", () => {
    test("usageBar fills correct number of blocks", async () => {
        const origNoColor = process.env["NO_COLOR"];
        process.env["NO_COLOR"] = "1";
        try {
            const mod = await import(`./cli-colors.ts?fill=${Date.now()}`);
            // 0% → all empty
            const empty = mod.usageBar(0, 10);
            expect(empty).toContain("░".repeat(10));
            // 100% → all filled
            const full = mod.usageBar(100, 10);
            expect(full).toContain("█".repeat(10));
            // 50% → 5 filled + 5 empty
            const half = mod.usageBar(50, 10);
            expect(half).toContain("█".repeat(5) + "░".repeat(5));
        } finally {
            if (origNoColor === undefined) delete process.env["NO_COLOR"];
            else process.env["NO_COLOR"] = origNoColor;
        }
    });

    test("usageBar clamps values outside 0-100", async () => {
        const origNoColor = process.env["NO_COLOR"];
        process.env["NO_COLOR"] = "1";
        try {
            const mod = await import(`./cli-colors.ts?clamp=${Date.now()}`);
            // Should not throw and should clamp correctly
            const over = mod.usageBar(150, 10);
            expect(over).toContain("100.0%");
            const under = mod.usageBar(-10, 10);
            expect(under).toContain("0.0%");
        } finally {
            if (origNoColor === undefined) delete process.env["NO_COLOR"];
            else process.env["NO_COLOR"] = origNoColor;
        }
    });

    test("c helpers are identity functions when NO_COLOR is set", async () => {
        const origNoColor = process.env["NO_COLOR"];
        process.env["NO_COLOR"] = "1";
        try {
            const mod = await import(`./cli-colors.ts?identity=${Date.now()}`);
            const { c } = mod;
            expect(c.brand("hello")).toBe("hello");
            expect(c.cmd("pizza")).toBe("pizza");
            expect(c.label("Commands")).toBe("Commands");
            expect(c.flag("--help")).toBe("--help");
            expect(c.success("✓")).toBe("✓");
            expect(c.error("✗")).toBe("✗");
            expect(c.dim("secondary")).toBe("secondary");
            expect(c.bold("bold text")).toBe("bold text");
            expect(c.accent("accent")).toBe("accent");
        } finally {
            if (origNoColor === undefined) delete process.env["NO_COLOR"];
            else process.env["NO_COLOR"] = origNoColor;
        }
    });
});
