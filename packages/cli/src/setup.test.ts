import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQrSetup, qrCodeUrl, requestHeadlessPairing } from "./setup.js";
import qrcode from "qrcode";
import { _setGlobalConfigDir } from "./config/io.js";

const originalHome = process.env.HOME;
let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-setup-test-"));
    process.env.HOME = tmpDir;
    _setGlobalConfigDir(tmpDir + "/.pizzapi");
});

afterEach(() => {
    process.env.HOME = originalHome;
    _setGlobalConfigDir(null);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("QR setup", () => {
    test("qrCodeUrl encodes token into setup page URL", () => {
        const url = qrCodeUrl("http://localhost:7492", "abc123");
        expect(url).toBe("http://localhost:7492/setup-claim?t=abc123");
    });

    test("qrcode terminal renderer produces non-empty output for setup URL", async () => {
        const url = qrCodeUrl("http://localhost:7492", "test-token-123");
        const rendered = await qrcode.toString(url, { type: "terminal", small: true });
        expect(rendered.length).toBeGreaterThan(10);
        // Terminal QR codes contain unicode block characters.
        expect(rendered).toMatch(/[\u2580-\u259f█\s]+/);
    });

    test("runQrSetup creates claim, prints QR, and saves config on approval", async () => {
        const relayUrl = "http://localhost:7999";
        const token = "claim-token-for-cli-test";
        const apiKey = "0".repeat(64);
        let createCalled = false;
        let pollCount = 0;

        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input.toString();
            if (url === `${relayUrl}/api/setup-claim`) {
                createCalled = true;
                return new Response(JSON.stringify({ token, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url === `${relayUrl}/api/setup-claim/${token}`) {
                pollCount++;
                if (pollCount < 2) {
                    return new Response(JSON.stringify({ status: "pending", relayUrl }), { status: 200 });
                }
                return new Response(JSON.stringify({ status: "approved", apiKey, relayUrl }), { status: 200 });
            }
            return originalFetch(input, init);
        }) as typeof fetch;

        try {
            const ok = await runQrSetup(relayUrl, 10);
            expect(ok).toBe(true);
            expect(createCalled).toBe(true);
            expect(pollCount).toBeGreaterThanOrEqual(2);

            const config = JSON.parse(readFileSync(join(tmpDir, ".pizzapi", "config.json"), "utf-8"));
            expect(config.apiKey).toBe(apiKey);
            expect(config.relayUrl).toBe("ws://localhost:7999");
            expect(process.env.PIZZAPI_API_KEY).toBe(apiKey);
            expect(process.env.PIZZAPI_RELAY_URL).toBe("ws://localhost:7999");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("runQrSetup reports failure when claim is rejected", async () => {
        const relayUrl = "http://localhost:7999";
        const token = "rejected-token";

        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = input.toString();
            if (url === `${relayUrl}/api/setup-claim`) {
                return new Response(JSON.stringify({ token, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url === `${relayUrl}/api/setup-claim/${token}`) {
                return new Response(JSON.stringify({ status: "expired", relayUrl }), { status: 200 });
            }
            return originalFetch(input);
        }) as typeof fetch;

        try {
            const ok = await runQrSetup(relayUrl, 10);
            expect(ok).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("requestHeadlessPairing sends the label, reports the claim URL, and resolves on approval", async () => {
        const relayUrl = "http://localhost:7999";
        const token = "headless-token";
        const apiKey = "1".repeat(64);
        let sentBody: any = null;
        let pollCount = 0;

        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input.toString();
            if (url === `${relayUrl}/api/setup-claim`) {
                sentBody = JSON.parse(init?.body as string);
                return new Response(JSON.stringify({ token, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url === `${relayUrl}/api/setup-claim/${token}`) {
                pollCount++;
                if (pollCount < 2) return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
                return new Response(JSON.stringify({ status: "approved", apiKey }), { status: 200 });
            }
            return originalFetch(input, init);
        }) as typeof fetch;

        try {
            let claimSeen: { claimUrl: string; expiresAt: string } | null = null;
            const result = await requestHeadlessPairing(relayUrl, {
                label: "my-runner",
                pollIntervalMs: 5,
                onClaim: (info) => { claimSeen = info; },
            });
            expect(sentBody).toEqual({ relayUrl, label: "my-runner" });
            expect(claimSeen).not.toBeNull();
            expect(claimSeen!.claimUrl).toBe(`${relayUrl}/setup-claim?t=${token}`);
            expect(result).toEqual({ apiKey, relayUrl: "ws://localhost:7999" });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("requestHeadlessPairing never touches saveGlobalConfig or process.env — persistence is the caller's job", async () => {
        const relayUrl = "http://localhost:7999";
        const token = "headless-token-2";
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = input.toString();
            if (url === `${relayUrl}/api/setup-claim`) {
                return new Response(JSON.stringify({ token, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), { status: 200 });
            }
            if (url === `${relayUrl}/api/setup-claim/${token}`) {
                return new Response(JSON.stringify({ status: "expired" }), { status: 200 });
            }
            return originalFetch(input);
        }) as typeof fetch;

        try {
            delete process.env.PIZZAPI_API_KEY;
            const result = await requestHeadlessPairing(relayUrl, { pollIntervalMs: 5 });
            expect("error" in result).toBe(true);
            expect(process.env.PIZZAPI_API_KEY).toBeUndefined();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // ponytail: runSetup()'s interactive wizard prompts via readline + raw-mode
    // stdin, which isn't worth mocking end-to-end here. The QR-setup test above
    // already exercises the identical saveGlobalConfig({ apiKey, relayUrl })
    // save behavior; this is a cheap regression guard against reintroducing the
    // exact audited bug (a save call that drops relayUrl) at either call site.
    test("both saveGlobalConfig call sites in setup.ts persist relayUrl alongside apiKey", () => {
        const source = readFileSync(join(import.meta.dir, "setup.ts"), "utf-8");
        const calls = source.match(/saveGlobalConfig\(\{[^}]*\}\)/g) ?? [];
        expect(calls.length).toBe(2);
        for (const call of calls) {
            expect(call).toContain("apiKey");
            expect(call).toContain("relayUrl");
        }
    });
});
