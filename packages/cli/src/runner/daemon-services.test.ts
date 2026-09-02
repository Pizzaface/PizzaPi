import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { resolveAnnouncedDisabledRunnerServices, resolveDisabledRunnerServices, resolveReconfiguredDisabledRunnerServices } from "./daemon.js";
import { _setGlobalConfigDir, loadGlobalConfig, saveGlobalConfig } from "../config/io.js";

describe("resolveDisabledRunnerServices", () => {
    test("returns empty set by default", () => {
        expect(resolveDisabledRunnerServices({})).toEqual(new Set());
    });

    test("collects IDs from config array", () => {
        expect(resolveDisabledRunnerServices({ disabledRunnerServices: ["git", "time"] })).toEqual(
            new Set(["git", "time"]),
        );
    });

    test("parses comma-separated env var", () => {
        expect(resolveDisabledRunnerServices({}, "git, time ,terminal")).toEqual(
            new Set(["git", "time", "terminal"]),
        );
    });

    test("merges env var and config", () => {
        expect(resolveDisabledRunnerServices({ disabledRunnerServices: ["git"] }, "time")).toEqual(
            new Set(["git", "time"]),
        );
    });

    test("ignores non-string config entries and empty env tokens", () => {
        expect(
            resolveDisabledRunnerServices(
                { disabledRunnerServices: ["git", 123 as unknown as string, null as unknown as string] },
                ",,time,",
            ),
        ).toEqual(new Set(["git", "time"]));
    });
});

describe("resolveReconfiguredDisabledRunnerServices", () => {
    test("applies a single disable on top of current runtime state", () => {
        expect(resolveReconfiguredDisabledRunnerServices(new Set(["taxonomy"]), {
            disabledServiceIds: ["nightshift"],
            serviceId: "nightshift",
            enabled: false,
        })).toEqual(new Set(["taxonomy", "nightshift"]));
    });

    test("applies a single enable on top of current runtime state", () => {
        expect(resolveReconfiguredDisabledRunnerServices(new Set(["taxonomy", "nightshift"]), {
            disabledServiceIds: [],
            serviceId: "taxonomy",
            enabled: true,
        })).toEqual(new Set(["nightshift"]));
    });

    test("falls back to full disabledServiceIds snapshots for old servers", () => {
        expect(resolveReconfiguredDisabledRunnerServices(new Set(["old"]), {
            disabledServiceIds: ["demo", 123, null],
        })).toEqual(new Set(["demo"]));
    });

    test("re-enable removes from disabled set", () => {
        expect(resolveReconfiguredDisabledRunnerServices(new Set(["demo", "nightshift"]), {
            disabledServiceIds: ["demo"],
            serviceId: "demo",
            enabled: true,
        })).toEqual(new Set(["nightshift"]));
    });
});

describe("packages are the only source of runner services (overlay spec §6.3, §12.4)", () => {
    const runnerDir = dirname(fileURLToPath(import.meta.url));
    const read = (f: string) => readFileSync(join(runnerDir, f), "utf-8");

    // Legacy discovery scanned ~/.pizzapi/services/, <cwd>/.pizzapi/services/ and
    // plugin dirs, mounting code on the daemon with no trust grant and no
    // provenance. The daemon owns ONE ServiceRegistry shared by every workspace,
    // so a project-scoped scan would activate one checkout's code for unrelated
    // sessions. Both concerns are now closed structurally: the scanners are gone
    // and package services carry an explicit per-package grant.
    test("service-loader.ts exports no directory or plugin scanner", () => {
        const src = read("service-loader.ts");
        for (const gone of [
            "discoverServices",
            "globalServicesDir",
            "projectServicesDir",
            "loadServicesFromDir",
            "loadServicesFromPlugins",
        ]) {
            expect(src).not.toContain(`export function ${gone}`);
            expect(src).not.toContain(`export async function ${gone}`);
        }
    });

    test("daemon.ts mounts services only via discoverPackageServices()", () => {
        const src = read("daemon.ts");
        // discoverPackageServices() is cwd-scoped by design (it resolves
        // project-scope packages to warn that their services stay inactive);
        // the bare legacy scanner must not come back.
        expect(src).not.toMatch(/(?<![A-Za-z])discoverServices\(/);
        expect(src).toMatch(/discoverPackageServices\(/);
    });

    test("only package-origin services can be registered", () => {
        expect(read("service-loader.ts")).toContain('origin: "package"');
    });
});

describe("resolveAnnouncedDisabledRunnerServices", () => {
    test("announces disabled IDs even when they are not loaded/discovered", () => {
        expect(resolveAnnouncedDisabledRunnerServices(new Set(["taxonomy", "demo"]))).toEqual(["taxonomy", "demo"]);
    });
});

describe("disabledRunnerServices round-trip", () => {
    let tempDir: string;

    test("saveGlobalConfig persists and loadGlobalConfig reads disabledRunnerServices", () => {
        tempDir = mkdtempSync(join(tmpdir(), "pizzapi-disabled-rt-"));
        _setGlobalConfigDir(tempDir);
        try {
            saveGlobalConfig({ disabledRunnerServices: ["github", "godmother"] });
            const raw = readFileSync(join(tempDir, "config.json"), "utf-8");
            expect(JSON.parse(raw).disabledRunnerServices).toEqual(["github", "godmother"]);

            const loaded = loadGlobalConfig();
            expect(loaded.disabledRunnerServices).toEqual(["github", "godmother"]);
            expect(resolveDisabledRunnerServices(loaded)).toEqual(new Set(["github", "godmother"]));
        } finally {
            _setGlobalConfigDir(null);
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
