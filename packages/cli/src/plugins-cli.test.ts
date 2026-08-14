import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
    getTrustedPlugins,
    isPluginTrusted,
    trustPlugin,
    untrustPlugin,
    _setGlobalConfigDir,
} from "./config.js";

/**
 * Tests for the plugin trust config helpers.
 *
 * Each test uses an isolated temporary global config directory.
 */

let tmpHome: string;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-plugins-cli-"));
    _setGlobalConfigDir(tmpHome);
});

afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tmpHome, { recursive: true, force: true });
});

function testPath(suffix: string): string {
    return `/tmp/__plugins-cli-test__-${suffix}-${Date.now()}`;
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
        // Stored form is the canonical (resolved) path.
        expect(getTrustedPlugins()).toContain(resolve(p));
    });

    test("trustPlugin is idempotent", () => {
        const p = testPath("idempotent");
        trustPlugin(p);
        const added = trustPlugin(p);
        expect(added).toBe(false);
        // Should only appear once
        expect(getTrustedPlugins().filter(x => x === resolve(p))).toHaveLength(1);
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
        expect(list).toContain(resolve(p));
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
