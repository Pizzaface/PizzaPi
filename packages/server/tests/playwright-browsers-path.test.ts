import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePlaywrightBrowsersPath } from "./harness/playwright-browsers";

describe("Playwright browser cache resolution", () => {
    test("browser smoke resolves the real browser cache with a clean HOME", () => {
        const previousHome = process.env.HOME;
        const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
        process.env.HOME = mkdtempSync(path.join(tmpdir(), "pizzapi-playwright-home-"));
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;

        try {
            ensurePlaywrightBrowsersPath();
            const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
            expect(browsersPath).toBeTruthy();
            expect(existsSync(browsersPath!)).toBe(true);
            expect(readdirSync(browsersPath!).some((entry) => entry.startsWith("chromium"))).toBe(true);
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
            else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
        }
    });
});
