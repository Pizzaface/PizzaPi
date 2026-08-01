import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    shouldAutoPair,
    resolveExistingApiKey,
    resolveKnownRelayUrl,
    pairingStatusPath,
    readPairingStatus,
    clearPairingStatus,
} from "./pairing.js";

describe("shouldAutoPair", () => {
    test("triggers when nothing is configured but a relay URL is known", () => {
        expect(
            shouldAutoPair({ hasApiKey: false, hasToken: false, relayUrl: "http://localhost:7492", pairingDisabled: false }),
        ).toBe(true);
    });

    test("does not trigger when an API key is already present", () => {
        expect(
            shouldAutoPair({ hasApiKey: true, hasToken: false, relayUrl: "http://localhost:7492", pairingDisabled: false }),
        ).toBe(false);
    });

    test("does not trigger when a server token is already present", () => {
        expect(
            shouldAutoPair({ hasApiKey: false, hasToken: true, relayUrl: "http://localhost:7492", pairingDisabled: false }),
        ).toBe(false);
    });

    test("does not trigger when no relay URL is known", () => {
        expect(
            shouldAutoPair({ hasApiKey: false, hasToken: false, relayUrl: undefined, pairingDisabled: false }),
        ).toBe(false);
    });

    test("does not trigger when pairing is explicitly disabled", () => {
        expect(
            shouldAutoPair({ hasApiKey: false, hasToken: false, relayUrl: "http://localhost:7492", pairingDisabled: true }),
        ).toBe(false);
    });
});

describe("resolveExistingApiKey", () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
        for (const k of ["PIZZAPI_RUNNER_API_KEY", "PIZZAPI_API_KEY", "PIZZAPI_API_TOKEN"]) delete process.env[k];
        Object.assign(process.env, originalEnv);
    });

    test("prefers PIZZAPI_RUNNER_API_KEY over the rest", () => {
        process.env.PIZZAPI_RUNNER_API_KEY = "runner-key";
        process.env.PIZZAPI_API_KEY = "api-key";
        expect(resolveExistingApiKey("config-key")).toBe("runner-key");
    });

    test("falls back to config apiKey when nothing else is set", () => {
        expect(resolveExistingApiKey("config-key")).toBe("config-key");
    });

    test("returns undefined when nothing is set", () => {
        expect(resolveExistingApiKey(undefined)).toBeUndefined();
    });
});

describe("resolveKnownRelayUrl", () => {
    const originalEnv = process.env.PIZZAPI_RELAY_URL;
    afterEach(() => {
        if (originalEnv === undefined) delete process.env.PIZZAPI_RELAY_URL;
        else process.env.PIZZAPI_RELAY_URL = originalEnv;
    });

    test("prefers the env var over config", () => {
        process.env.PIZZAPI_RELAY_URL = "http://env:7492";
        expect(resolveKnownRelayUrl("http://config:7492")).toBe("http://env:7492");
    });

    test("falls back to config when env is unset", () => {
        delete process.env.PIZZAPI_RELAY_URL;
        expect(resolveKnownRelayUrl("http://config:7492")).toBe("http://config:7492");
    });

    test("returns undefined when neither is set — no silent localhost default", () => {
        delete process.env.PIZZAPI_RELAY_URL;
        expect(resolveKnownRelayUrl(undefined)).toBeUndefined();
    });

    test("treats config relayUrl of \"off\" as unset", () => {
        delete process.env.PIZZAPI_RELAY_URL;
        expect(resolveKnownRelayUrl("off")).toBeUndefined();
    });

    test("strips a trailing slash", () => {
        process.env.PIZZAPI_RELAY_URL = "http://env:7492/";
        expect(resolveKnownRelayUrl(undefined)).toBe("http://env:7492");
    });
});

describe("pairing status file", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-pairing-test-"));
    });
    afterEach(() => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test("readPairingStatus returns null when no file exists", () => {
        expect(readPairingStatus(pairingStatusPath(tmpDir))).toBeNull();
    });

    test("clearPairingStatus is a no-op when nothing exists", () => {
        expect(() => clearPairingStatus(pairingStatusPath(tmpDir))).not.toThrow();
    });

    test("roundtrips a written status file", () => {
        const path = pairingStatusPath(tmpDir);
        const status = { claimUrl: "http://x/setup-claim?t=abc", relayUrl: "http://x", startedAt: new Date().toISOString() };
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(status), { mode: 0o600 });
        expect(readPairingStatus(path)).toEqual(status);
        clearPairingStatus(path);
        expect(readPairingStatus(path)).toBeNull();
    });
});
