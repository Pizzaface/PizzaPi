/**
 * Browser smoke test — authenticates through the real UI, verifies live
 * sessions/runners, spawns a new session via the sandbox API, reloads the
 * page, and asserts the UI reconnects.
 *
 * This test starts the PizzaPi sandbox in headless mode with an in-memory
 * Redis instance. The sandbox is always terminated in afterAll, even if the
 * test fails.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "@playwright/test";
import { RedisMemoryServer } from "redis-memory-server";

const TIMEOUT_MS = 120_000;

interface SandboxUrls {
    uiUrl: string;
    serverUrl: string;
    apiUrl: string;
}

interface Credentials {
    email: string;
    password: string;
}

async function parseSandboxReady(proc: ReturnType<typeof Bun.spawn>): Promise<SandboxUrls & Credentials> {
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") throw new Error("Sandbox stdout is not available");

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let uiLine: string | null = null;
    let apiLine: string | null = null;
    const deadline = Date.now() + 60_000;

    try {
        while (Date.now() < deadline) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!uiLine && line.includes("UI (HMR):")) uiLine = line;
                if (!apiLine && line.includes("API:")) apiLine = line;
                if (uiLine && apiLine) break;
            }
            if (uiLine && apiLine) break;
        }
    } finally {
        reader.releaseLock();
    }

    if (!uiLine || !apiLine) {
        throw new Error(`Could not parse sandbox URLs. uiLine=${uiLine} apiLine=${apiLine}`);
    }

    const uiMatch = uiLine.match(/UI \(HMR\):\s+(http:\/\/[^\s]+)/);
    const apiMatch = apiLine.match(/API:\s+(http:\/\/[^\s]+)/);

    if (!uiMatch || !apiMatch) {
        throw new Error(`Could not parse sandbox URLs from lines:\n${uiLine}\n${apiLine}`);
    }

    const uiUrl = uiMatch[1];
    const apiUrl = apiMatch[1];

    // /status gives us the server URL and credentials.
    const statusRes = await fetch(`${apiUrl}/status`);
    if (!statusRes.ok) {
        throw new Error(`Sandbox status endpoint returned ${statusRes.status}`);
    }
    const status = (await statusRes.json()) as {
        serverUrl: string;
        credentials: { email: string; password: string };
    };

    return {
        uiUrl,
        serverUrl: status.serverUrl,
        apiUrl,
        email: status.credentials.email,
        password: status.credentials.password,
    };
}

async function sandboxApiPost(apiUrl: string, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Sandbox API ${path} returned ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

let redisServer: RedisMemoryServer;
let proc: ReturnType<typeof Bun.spawn>; // bun subprocess
let stderrBuffer = "";
let browser: Browser;
let page: Page;
let urls: SandboxUrls & Credentials;

describe("browser smoke — sandbox UI", () => {
    beforeAll(async () => {
        stderrBuffer = "";

        // Start the in-memory Redis in this process so its lifecycle is tied
        // to the test, not to the sandbox subprocess. This avoids the sandbox's
        // own RedisMemoryServer being reaped by subprocess signal handling.
        redisServer = await RedisMemoryServer.create({
            instance: { ip: "127.0.0.1", port: 0 },
            autoStart: true,
        } as any);
        const redisHost = await redisServer.getHost();
        const redisPort = await redisServer.getPort();
        process.env.PIZZAPI_REDIS_URL = `redis://${redisHost}:${redisPort}`;

        proc = Bun.spawn({
            cmd: ["bun", "packages/server/tests/harness/sandbox.ts", "--headless", "--redis=env"],
            cwd: process.cwd(),
            env: { ...process.env, PIZZAPI_SANDBOX_NO_TLS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });

        // Collect stderr for debugging Vite transform errors.
        (async () => {
            const stderr = proc.stderr;
            if (!stderr || typeof stderr === "number") return;
            const reader = (stderr as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    stderrBuffer += decoder.decode(value, { stream: true });
                }
            } catch { /* ignore */ }
        })();

        urls = await parseSandboxReady(proc);

        browser = await chromium.launch({ headless: true });
        page = await browser.newPage();
    }, TIMEOUT_MS);

    afterAll(async () => {
        try {
            await page?.close();
        } catch { /* ignore */ }
        try {
            await browser?.close();
        } catch { /* ignore */ }
        try {
            proc?.kill();
        } catch { /* ignore */ }
        // Give the sandbox process a moment to exit, then force-kill if needed.
        await new Promise((r) => setTimeout(r, 500));
        try {
            if (proc?.pid) process.kill(proc.pid, "SIGKILL");
        } catch { /* ignore */ }
        try {
            await redisServer?.stop();
        } catch { /* ignore */ }
    }, TIMEOUT_MS);

    test(
        "logs in, sees runner and sessions, spawns a session, and survives reload",
        async () => {
            page.on("console", (msg) => {
                if (msg.type() === "error") {
                    console.error("[browser error]", msg.text());
                }
            });
            page.on("pageerror", (err) => {
                console.error("[browser pageerror]", err.message);
            });
            page.on("response", async (res) => {
                if (res.status() >= 500) {
                    const url = res.url();
                    console.error(`[browser 500] ${url} ${res.status()}`);
                    try {
                        const body = await res.text();
                        console.error("[browser 500 body]", body.slice(0, 1000));
                    } catch { /* ignore */ }
                }
            });

            await page.goto(urls.uiUrl);
            try {
                await page.waitForSelector("#auth-email", { timeout: 90_000 });
            } catch (err) {
                const html = await page.content();
                const title = await page.title();
                console.error("Auth page did not render. Title:", title);
                console.error("HTML snippet:", html.slice(0, 2000));
                console.error("Sandbox stderr tail:\n", stderrBuffer.slice(-4000));
                throw err;
            }

            // The sign-in tab is active by default.
            await page.fill("#auth-email", urls.email);
            await page.fill("#auth-password", urls.password);
            await page.click('button[type="submit"]');

            // After login, the main app layout with the sidebar should appear.
            await page.waitForSelector('[data-session-row]', { timeout: 20_000 });

            // Verify the default sandbox runner appears.
            await page.click('button:has-text("Runners")');
            await page.waitForSelector('button:has-text("sandbox-runner")', { timeout: 10_000 });

            // Back to sessions.
            await page.click('button:has-text("Sessions")');
            const initialRows = await page.locator('[data-session-row]').count();
            expect(initialRows).toBeGreaterThanOrEqual(1);

            // Spawn a new session via the sandbox API.
            const spawnRes = (await sandboxApiPost(urls.apiUrl, "/session", {
                name: "browser-smoke-session",
                cwd: "/tmp/browser-smoke",
            })) as { index?: number; sessionId?: string };
            expect(spawnRes.sessionId).toBeTruthy();

            // The new session should appear in the sidebar via the hub socket.
            const started = Date.now();
            let count = initialRows;
            while (Date.now() - started < 15_000) {
                count = await page.locator('[data-session-row]').count();
                if (count > initialRows) break;
                await new Promise((r) => setTimeout(r, 250));
            }
            expect(count).toBeGreaterThan(initialRows);

            // Reload and verify the UI reconnects and sessions remain visible.
            await page.reload();
            await page.waitForSelector('[data-session-row]', { timeout: 20_000 });
            const afterReload = await page.locator('[data-session-row]').count();
            expect(afterReload).toBeGreaterThanOrEqual(initialRows + 1);
        },
        TIMEOUT_MS,
    );
});
