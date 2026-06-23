import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDisabledRunnerServices } from "./daemon.js";
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
