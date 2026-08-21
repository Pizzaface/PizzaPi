import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAuthContext, runWithAuthContext } from "../../auth.js";
import { runAllMigrations } from "../../migrations.js";
import { handleFetch } from "../../handler.js";
import { mintEphemeralApiKey } from "../../routes/utils.js";
import { browserAuthMiddleware, parseHandshakeProtocolVersion } from "./auth";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-ns-auth-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

const TRUSTED_ORIGIN = "http://trusted.example.com";
const UNTRUSTED_ORIGIN = "http://evil.example.com";

function setTrustedOrigins(...origins: string[]) {
    authContext.trustedOrigins.splice(0, authContext.trustedOrigins.length, ...origins);
}

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
});

async function createTestUser(id: string): Promise<string> {
    return await runWithAuthContext(authContext, async () => {
        const created = await authContext.auth.api.signUpEmail({
            body: {
                email: `${id}@example.com`,
                password: "Password123!",
                name: id,
            },
        });
        if (!created.user?.id) throw new Error("Failed to create test user");
        return created.user.id;
    });
}

async function getSessionCookieFor(email: string, password: string): Promise<string> {
    return await runWithAuthContext(authContext, async () => {
        const req = new Request("http://localhost:7492/api/auth/sign-in/email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        const res = await handleFetch(req, authContext);
        const cookie = res.headers.get("set-cookie");
        if (!cookie) throw new Error("Expected set-cookie header from sign-in");
        return cookie;
    });
}

function makeSocket(opts: { apiKey?: string; origin?: string; cookie?: string }): any {
    return {
        id: `test-${crypto.randomUUID()}`,
        handshake: {
            auth: { apiKey: opts.apiKey },
            headers: {
                origin: opts.origin,
                cookie: opts.cookie,
            },
        },
        data: {},
    };
}

async function runMiddleware(socket: any): Promise<{ error?: Error; userId?: string; userName?: string }> {
    const middleware = browserAuthMiddleware(authContext);
    let captured: Error | undefined;
    await middleware(socket, (err?: Error) => {
        captured = err;
    });
    return {
        error: captured,
        userId: socket.data?.userId,
        userName: socket.data?.userName,
    };
}

describe("parseHandshakeProtocolVersion", () => {
    test("returns numeric protocolVersion directly", () => {
        const socket = {
            handshake: { auth: { protocolVersion: 3 } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBe(3);
    });

    test("parses integer protocolVersion from string", () => {
        const socket = {
            handshake: { auth: { protocolVersion: "4" } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBe(4);
    });

    test("returns undefined for invalid values", () => {
        const socket = {
            handshake: { auth: { protocolVersion: "v1" } },
        } as any;

        expect(parseHandshakeProtocolVersion(socket)).toBeUndefined();
    });
});

describe("browserAuthMiddleware", () => {
    let userId = "";

    beforeAll(async () => {
        userId = await createTestUser("ns-auth-user");
    });

    beforeAll(() => {
        // Start each describe block with a known, explicit origin list.
        setTrustedOrigins(TRUSTED_ORIGIN);
    });

    test("API key + untrusted Origin is rejected before key validation", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const key = await runWithAuthContext(authContext, () =>
            mintEphemeralApiKey(userId, "browser-untrusted", 60),
        );
        const socket = makeSocket({ apiKey: key, origin: UNTRUSTED_ORIGIN });
        const result = await runMiddleware(socket);

        expect(result.error?.message).toBe("forbidden: untrusted origin");
        expect(result.userId).toBeUndefined();
    });

    test("API key + trusted Origin is accepted", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const key = await runWithAuthContext(authContext, () =>
            mintEphemeralApiKey(userId, "browser-trusted", 60),
        );
        const socket = makeSocket({ apiKey: key, origin: TRUSTED_ORIGIN });
        const result = await runMiddleware(socket);

        expect(result.error).toBeUndefined();
        expect(result.userId).toBe(userId);
        expect(typeof result.userName).toBe("string");
    });

    test("API key + no Origin is accepted (non-browser CLI/runner client)", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const key = await runWithAuthContext(authContext, () =>
            mintEphemeralApiKey(userId, "cli-runner", 60),
        );
        const socket = makeSocket({ apiKey: key });
        const result = await runMiddleware(socket);

        expect(result.error).toBeUndefined();
        expect(result.userId).toBe(userId);
    });

    test("invalid API key + no Origin falls through to cookie auth and is rejected without cookie", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const socket = makeSocket({ apiKey: "not-a-real-key" });
        const result = await runMiddleware(socket);

        expect(result.error?.message).toBe("unauthorized");
    });

    test("cookie auth + untrusted Origin is rejected", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const cookie = await getSessionCookieFor("ns-auth-user@example.com", "Password123!");
        const socket = makeSocket({ cookie, origin: UNTRUSTED_ORIGIN });
        const result = await runMiddleware(socket);

        expect(result.error?.message).toBe("forbidden: untrusted origin");
        expect(result.userId).toBeUndefined();
    });

    test("cookie auth + trusted Origin is accepted", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const cookie = await getSessionCookieFor("ns-auth-user@example.com", "Password123!");
        const socket = makeSocket({ cookie, origin: TRUSTED_ORIGIN });
        const result = await runMiddleware(socket);

        expect(result.error).toBeUndefined();
        expect(result.userId).toBe(userId);
    });

    test("cookie auth + trusted Origin without cookie is rejected", async () => {
        setTrustedOrigins(TRUSTED_ORIGIN);
        const socket = makeSocket({ origin: TRUSTED_ORIGIN });
        const result = await runMiddleware(socket);

        expect(result.error?.message).toBe("unauthorized");
    });
});
