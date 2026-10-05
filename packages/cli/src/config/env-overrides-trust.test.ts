import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loadConfig, mergeEnvOverrides, GLOBAL_ONLY_ENV_OVERRIDES, _setGlobalConfigDir } from "./io.js";

let tmpHome: string;
let projectDir: string;

function writeGlobal(cfg: unknown) {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(cfg));
}
function writeProject(cfg: unknown) {
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify(cfg));
}

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-env-overrides-"));
    projectDir = join(tmpHome, "project");
    mkdirSync(projectDir, { recursive: true });
    _setGlobalConfigDir(tmpHome);
});

afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tmpHome, { recursive: true, force: true });
});

describe("project envOverrides cannot relax security controls", () => {
    test("a project cannot inject any global-only key", () => {
        writeGlobal({});
        const hostile: Record<string, string> = { PIZZAPI_NO_MCP: "1" };
        for (const key of GLOBAL_ONLY_ENV_OVERRIDES) hostile[key] = "1";
        writeProject({ envOverrides: hostile });

        const overrides = loadConfig(projectDir).envOverrides ?? {};
        for (const key of GLOBAL_ONLY_ENV_OVERRIDES) expect(overrides[key]).toBeUndefined();
        // Ordinary keys still flow through from the project.
        expect(overrides.PIZZAPI_NO_MCP).toBe("1");
    });

    test("covers the escape hatches added by the security fixes", () => {
        for (const key of [
            "PIZZAPI_SANDBOX_ALLOW_UNSANDBOXED",
            "PIZZAPI_PLAN_MODE_ALLOWED_TOOLS",
            "PIZZAPI_BASH_PASSTHROUGH_ENV",
        ]) {
            expect(GLOBAL_ONLY_ENV_OVERRIDES.has(key)).toBe(true);
        }
    });

    test("a project cannot override a global value of a global-only key", () => {
        writeGlobal({ envOverrides: { PIZZAPI_PLAN_MODE_ALLOWED_TOOLS: "mcp__docs__search" } });
        writeProject({ envOverrides: { PIZZAPI_PLAN_MODE_ALLOWED_TOOLS: "bash_write_anything" } });

        expect(loadConfig(projectDir).envOverrides?.PIZZAPI_PLAN_MODE_ALLOWED_TOOLS).toBe("mcp__docs__search");
    });

    test("global-only keys set globally survive a project envOverrides block", () => {
        writeGlobal({ envOverrides: { PIZZAPI_SANDBOX_ALLOW_UNSANDBOXED: "1", PIZZAPI_NO_MCP: "0" } });
        writeProject({ envOverrides: { PIZZAPI_NO_MCP: "1" } });

        const overrides = loadConfig(projectDir).envOverrides ?? {};
        expect(overrides.PIZZAPI_SANDBOX_ALLOW_UNSANDBOXED).toBe("1");
        // Ordinary keys keep the existing project-replaces-global behaviour.
        expect(overrides.PIZZAPI_NO_MCP).toBe("1");
    });

    test("global-only overrides are kept when the project has no envOverrides", () => {
        writeGlobal({ envOverrides: { PIZZAPI_BASH_PASSTHROUGH_ENV: "MY_TOKEN" } });
        writeProject({ model: { provider: "x", id: "y" } });

        expect(loadConfig(projectDir).envOverrides?.PIZZAPI_BASH_PASSTHROUGH_ENV).toBe("MY_TOKEN");
    });

    test("mergeEnvOverrides drops project global-only keys and restores global ones", () => {
        expect(
            mergeEnvOverrides(
                { PIZZAPI_ALLOW_PROJECT_HOOKS: "0", PIZZAPI_FOO: "g" },
                { PIZZAPI_ALLOW_PROJECT_HOOKS: "1", PIZZAPI_BAR: "p" },
            ),
        ).toEqual({ PIZZAPI_ALLOW_PROJECT_HOOKS: "0", PIZZAPI_BAR: "p" });
    });
});
