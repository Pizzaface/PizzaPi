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
    ensureRunnerCredentials,
} from "./pairing.js";
import { _setGlobalConfigDir } from "../config/io.js";

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

describe("ensureRunnerCredentials — ws:// relayUrl round-trip regression", () => {
    // Pins the bug class caught in review: a *second* pairing attempt
    // (auto-pair re-triggering after apiKey was cleared but relayUrl
    // wasn't, or any future caller of ensureRunnerCredentials with a
    // config-sourced relayUrl) must not hand the ws(s):// value straight to
    // a REST fetch() — it must go through toHttpRelayUrl first (relay-url.ts).
    let tmpDir: string;
    const originalFetch = globalThis.fetch;
    const envKeys = [
        "PIZZAPI_RUNNER_API_KEY",
        "PIZZAPI_API_KEY",
        "PIZZAPI_API_TOKEN",
        "PIZZAPI_RUNNER_TOKEN",
        "PIZZAPI_PAIRING",
        "PIZZAPI_RELAY_URL",
        "PIZZAPI_RUNNER_NAME",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-pairing-regression-test-"));
        _setGlobalConfigDir(join(tmpDir, ".pizzapi"));
        for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        _setGlobalConfigDir(null);
        globalThis.fetch = originalFetch;
        for (const k of envKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test("config-sourced ws:// relayUrl still targets http(s) for the setup-claim REST call", async () => {
        const agentDir = join(tmpDir, ".pizzapi");
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, "config.json"), JSON.stringify({ relayUrl: "ws://localhost:7999" }));

        const requestedUrls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = input.toString();
            requestedUrls.push(url);
            if (url === "http://localhost:7999/api/setup-claim") {
                return new Response(
                    JSON.stringify({ token: "tok", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            if (url === "http://localhost:7999/api/setup-claim/tok") {
                return new Response(JSON.stringify({ status: "approved", apiKey: "a".repeat(64) }), { status: 200 });
            }
            throw new Error(`unexpected fetch to ${url}`);
        }) as typeof fetch;

        const exitCode = await ensureRunnerCredentials(agentDir);

        expect(exitCode).toBeNull(); // pairing succeeded, startup continues
        expect(requestedUrls.length).toBeGreaterThan(0);
        for (const url of requestedUrls) {
            expect(url.startsWith("ws://")).toBe(false);
            expect(url.startsWith("http://localhost:7999")).toBe(true);
        }
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
