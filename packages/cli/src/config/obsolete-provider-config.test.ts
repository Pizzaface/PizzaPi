/**
 * The extension-provider layer was removed, but users still have `providers`
 * and `allowProjectProviders` in their configs. Overlay spec §12.4 requires the
 * config reader to survive removal long enough to emit a targeted warning, so a
 * configured-but-inert provider does not silently look healthy.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, _setGlobalConfigDir } from "./io.js";

let tmpHome: string;
let projectDir: string;

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-obsolete-providers-"));
    projectDir = join(tmpHome, "project");
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    _setGlobalConfigDir(tmpHome);
});

afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tmpHome, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(config));
}

function writeProject(config: unknown): void {
    writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify(config));
}

/** Capture warnings emitted during a single loadConfig call. */
function captureWarnings(fn: () => void): string[] {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
        fn();
    } finally {
        console.warn = orig;
    }
    return warnings;
}

describe("obsolete extension-provider config", () => {
    test("warns and names each configured provider id from the global config", () => {
        writeGlobal({ providers: { "message-bridge": { enabled: true }, other: {} } });

        const warnings = captureWarnings(() => loadConfig(projectDir));
        const joined = warnings.join("\n");

        expect(joined).toContain("providers");
        expect(joined).toContain("message-bridge");
        expect(joined).toContain("other");
        expect(joined).toContain("~/.pizzapi/config.json");
    });

    test("points at a runner service as the replacement for external connectivity", () => {
        writeGlobal({ providers: { "message-bridge": { enabled: true } } });

        const joined = captureWarnings(() => loadConfig(projectDir)).join("\n");

        expect(joined).toContain("pi.pizzapi.services");
        expect(joined).toContain("daemon-scoped");
    });

    test("names the project config when the obsolete key lives there", () => {
        writeProject({ providers: { "proj-prov": {} } });

        const joined = captureWarnings(() => loadConfig(projectDir)).join("\n");

        expect(joined).toContain(".pizzapi/config.json");
        expect(joined).toContain("proj-prov");
    });

    test("warns about allowProjectProviders even with no providers configured", () => {
        writeGlobal({ allowProjectProviders: true });

        const joined = captureWarnings(() => loadConfig(projectDir)).join("\n");

        expect(joined).toContain("allowProjectProviders");
        expect(joined).toContain("obsolete");
    });

    test("warns about allowProjectProviders: false too — the key is inert either way", () => {
        writeGlobal({ allowProjectProviders: false });

        const joined = captureWarnings(() => loadConfig(projectDir)).join("\n");

        expect(joined).toContain("allowProjectProviders");
    });

    test("stays silent when neither obsolete key is present", () => {
        writeGlobal({ relayUrl: "https://example.test" });

        const warnings = captureWarnings(() => loadConfig(projectDir));

        expect(warnings.join("\n")).not.toContain("obsolete");
    });

    test("an empty providers object is not worth warning about", () => {
        writeGlobal({ providers: {} });

        const warnings = captureWarnings(() => loadConfig(projectDir));

        expect(warnings.join("\n")).not.toContain("'providers'");
    });

    test("loadConfig still succeeds and ignores the obsolete keys", () => {
        writeGlobal({ providers: { "message-bridge": { enabled: true } }, relayUrl: "https://example.test" });

        const config = captureWarningsAndReturn(() => loadConfig(projectDir));

        // The obsolete key is still declared (just inert); what matters is that
        // nothing throws and unrelated config still loads.
        expect(config.relayUrl).toBe("https://example.test");
    });
});

function captureWarningsAndReturn<T>(fn: () => T): T {
    const orig = console.warn;
    console.warn = () => {};
    try {
        return fn();
    } finally {
        console.warn = orig;
    }
}
