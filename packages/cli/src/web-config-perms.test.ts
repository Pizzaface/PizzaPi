/**
 * `~/.pizzapi/web/config.json` holds betterAuthSecret, the VAPID private key,
 * and (since host-tunnel DNS-01 settings became persistent) a DNS provider API
 * token, so it must be 0600.
 *
 * This tests writeJsonSecure by path rather than saveWebConfig, deliberately:
 * web.ts derives CONFIG_PATH from os.homedir() at module scope, and Bun's
 * homedir() IGNORES $HOME. A test that redirected HOME and called
 * saveWebConfig() would silently overwrite the developer's real relay config.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync, readdirSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureSecureDir, writeComposeSecure, writeFileSecure, writeJsonSecure } from "./web.js";

const dir = mkdtempSync(join(tmpdir(), "pizzapi-webcfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe("writeJsonSecure", () => {
    test("creates the file 0600, including missing parent dirs", () => {
        const path = join(dir, "nested", "config.json");
        writeJsonSecure(path, { betterAuthSecret: "secret" });
        expect(mode(path)).toBe(0o600);
        expect(JSON.parse(readFileSync(path, "utf-8")).betterAuthSecret).toBe("secret");
    });

    // Regression: writeFileSync's `mode` is only honoured when it CREATES the
    // file. Configs written before caddyDnsToken existed are already 0644 on
    // disk, so without an explicit chmod the token lands world-readable.
    test("tightens an existing 0644 file to 0600", () => {
        const path = join(dir, "existing.json");
        writeFileSync(path, "{}\n", { mode: 0o644 });
        expect(mode(path)).toBe(0o644);

        writeJsonSecure(path, { caddyDnsToken: "cfut_token" });

        expect(mode(path)).toBe(0o600);
        expect(JSON.parse(readFileSync(path, "utf-8")).caddyDnsToken).toBe("cfut_token");
    });
});

// F16: compose.yml duplicates BETTER_AUTH_SECRET, the VAPID private key, the
// ntfy publish token and optional DNS credentials, so it gets the same 0600
// treatment as config.json, and ~/.pizzapi/web is kept 0700.
describe("secure compose.yml / web dir", () => {
    const withUmask = <T>(umask: number, fn: () => T): T => {
        const prev = process.umask(umask);
        try {
            return fn();
        } finally {
            process.umask(prev);
        }
    };

    test("first-time generation under umask 0022 yields a 0700 dir and 0600 compose.yml", () => {
        const webDir = join(dir, "first", ".pizzapi", "web");
        const composePath = join(webDir, "compose.yml");
        withUmask(0o022, () => {
            ensureSecureDir(webDir);
            expect(writeComposeSecure(composePath, "BETTER_AUTH_SECRET=s3cret\n")).toBe("created");
        });
        expect(mode(join(dir, "first", ".pizzapi"))).toBe(0o700);
        expect(mode(webDir)).toBe(0o700);
        expect(mode(composePath)).toBe(0o600);
        expect(readFileSync(composePath, "utf-8")).toBe("BETTER_AUTH_SECRET=s3cret\n");
    });

    test("repairs an existing 0755 web dir", () => {
        const webDir = join(dir, "loose-dir");
        mkdirSync(webDir, { mode: 0o755 });
        chmodSync(webDir, 0o755);
        ensureSecureDir(webDir);
        expect(mode(webDir)).toBe(0o700);
    });

    test("repairs a preexisting 0644 compose.yml even when content is unchanged", () => {
        const composePath = join(dir, "unchanged-compose.yml");
        writeFileSync(composePath, "same\n", { mode: 0o644 });
        chmodSync(composePath, 0o644);

        expect(writeComposeSecure(composePath, "same\n")).toBe("unchanged");
        expect(mode(composePath)).toBe(0o600);
    });

    test("replaces a preexisting 0644 compose.yml atomically with a 0600 file", () => {
        const sub = join(dir, "atomic");
        mkdirSync(sub);
        const composePath = join(sub, "compose.yml");
        writeFileSync(composePath, "old\n", { mode: 0o644 });
        chmodSync(composePath, 0o644);

        withUmask(0o022, () => {
            expect(writeComposeSecure(composePath, "new\n")).toBe("updated");
        });
        expect(mode(composePath)).toBe(0o600);
        expect(readFileSync(composePath, "utf-8")).toBe("new\n");
        // No temp files left behind.
        expect(readdirSync(sub)).toEqual(["compose.yml"]);
    });

    test("writeFileSecure leaves no temp file behind when the write fails", () => {
        const sub = join(dir, "fail");
        mkdirSync(sub);
        // Target is a non-empty directory, so the final rename fails.
        mkdirSync(join(sub, "compose.yml", "x"), { recursive: true });
        expect(() => writeFileSecure(join(sub, "compose.yml"), "secret")).toThrow();
        expect(readdirSync(sub)).toEqual(["compose.yml"]);
    });
});
