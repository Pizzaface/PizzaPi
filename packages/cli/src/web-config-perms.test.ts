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
import { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeJsonSecure } from "./web.js";

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
