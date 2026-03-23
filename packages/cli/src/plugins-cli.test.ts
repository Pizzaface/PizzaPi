import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
    getTrustedPlugins,
    isPluginTrusted,
    trustPlugin,
    untrustPlugin,
} from "./config.js";

/**
 * Tests for the plugin trust config helpers.
 *
 * These use unique path names to avoid collisions with any real trusted
 * plugins. The real ~/.pizzapi/config.json is snapshotted before tests
 * and unconditionally restored after, so even a crash mid-test cannot
 * corrupt the user's config.
 */

const CONFIG_PATH = join(homedir(), ".pizzapi", "config.json");
let configSnapshot: string | null = null;

beforeAll(() => {
    // Snapshot the real config so we can restore it no matter what
    try {
        configSnapshot = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8") : null;
    } catch {
        configSnapshot = null;
    }
});

afterAll(() => {
    // Unconditionally restore the original config — this runs even if tests crash
    try {
        if (configSnapshot !== null) {
            writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
        }
    } catch {
        // Best-effort restore
    }
});

const TEST_PREFIX = "/tmp/__plugins-cli-test__";
const testPaths: string[] = [];

function testPath(suffix: string): string {
    const p = `${TEST_PREFIX}-${suffix}-${Date.now()}`;
    testPaths.push(p);
    return p;
}

describe("plugin trust config helpers", () => {
    test("isPluginTrusted returns false for unknown plugin", () => {
        expect(isPluginTrusted(testPath("unknown"))).toBe(false);
    });

    test("trustPlugin adds to the list and isPluginTrusted returns true", () => {
        const p = testPath("add");
        const added = trustPlugin(p);
        expect(added).toBe(true);
        expect(isPluginTrusted(p)).toBe(true);
        expect(getTrustedPlugins()).toContain(p);
    });

    test("trustPlugin is idempotent", () => {
        const p = testPath("idempotent");
        trustPlugin(p);
        const added = trustPlugin(p);
        expect(added).toBe(false);
        // Should only appear once
        expect(getTrustedPlugins().filter(x => x === p)).toHaveLength(1);
    });

    test("isPluginTrusted handles trailing slashes", () => {
        const p = testPath("trailing");
        trustPlugin(p);
        expect(isPluginTrusted(p + "/")).toBe(true);
    });

    test("untrustPlugin removes from the list", () => {
        const p = testPath("remove");
        trustPlugin(p);
        expect(isPluginTrusted(p)).toBe(true);

        const removed = untrustPlugin(p);
        expect(removed).toBe(true);
        expect(isPluginTrusted(p)).toBe(false);
        expect(getTrustedPlugins()).not.toContain(p);
    });

    test("untrustPlugin is idempotent", () => {
        const p = testPath("untrust-idempotent");
        // Never trusted, so removing should return false
        const removed = untrustPlugin(p);
        expect(removed).toBe(false);
    });

    test("trust persists across fresh reads", () => {
        const p = testPath("persist");
        trustPlugin(p);
        // getTrustedPlugins reads from disk each time
        const list = getTrustedPlugins();
        expect(list).toContain(p);
    });

    test("multiple plugins can be trusted independently", () => {
        const px = testPath("multi-x");
        const py = testPath("multi-y");
        const pz = testPath("multi-z");

        trustPlugin(px);
        trustPlugin(py);
        trustPlugin(pz);

        expect(isPluginTrusted(px)).toBe(true);
        expect(isPluginTrusted(py)).toBe(true);
        expect(isPluginTrusted(pz)).toBe(true);

        untrustPlugin(py);
        expect(isPluginTrusted(px)).toBe(true);
        expect(isPluginTrusted(py)).toBe(false);
        expect(isPluginTrusted(pz)).toBe(true);
    });
});
