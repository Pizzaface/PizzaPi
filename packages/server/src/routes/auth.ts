/**
 * Auth router — handles user registration and signup status.
 *
 * Note: better-auth's own `/api/auth/*` routes (sign-in, sign-up, change-password,
 * etc.) are handled directly in handler.ts. This router covers the *custom*
 * registration endpoint and the signup-status check.
 */

import { getApiKeyRateLimitConfig, getAuth, getKysely, isSignupAllowed } from "../auth.js";
import { RateLimiter, isValidEmail, isValidPassword, getClientIp } from "../security.js";
import { PASSWORD_REQUIREMENTS_SUMMARY } from "@pizzapi/protocol";
import type { RouteHandler } from "./types.js";

// 5 requests per 15 minutes
const registerRateLimiter = new RateLimiter(5, 15 * 60 * 1000);

export const handleAuthRoute: RouteHandler = async (req, url) => {
    // ── Public endpoint: signup status ───────────────────────────────
    if (url.pathname === "/api/signup-status" && req.method === "GET") {
        const allowed = await isSignupAllowed();
        return Response.json({ signupEnabled: allowed });
    }

    // ── Public endpoint: register (create user + generate CLI API key) ──
    if (url.pathname === "/api/register" && req.method === "POST") {
        const clientIp = getClientIp(req);
        if (!registerRateLimiter.check(clientIp)) {
            return Response.json(
                { error: "Too many registration attempts. Please try again later." },
                { status: 429 },
            );
        }

        const body = (await req.json()) as { name?: string; email?: string; password?: string };
        const { name, email, password } = body;
        if (!email || !password) {
            return Response.json({ error: "Missing required fields: email, password" }, { status: 400 });
        }

        if (!isValidEmail(email)) {
            return Response.json({ error: "Invalid email format" }, { status: 400 });
        }

        if (!isValidPassword(password)) {
            return Response.json({ error: PASSWORD_REQUIREMENTS_SUMMARY }, { status: 400 });
        }

        const existing = await getKysely()
            .selectFrom("user")
            .select("id")
            .where("email", "=", email)
            .executeTakeFirst();

        let userId: string;
        if (existing) {
            // Verify password by attempting sign-in
            const signIn = await getAuth()
                .api.signInEmail({ body: { email, password } })
                .catch(() => null);
            if (!signIn?.user?.id) {
                return Response.json({ error: "Invalid credentials" }, { status: 401 });
            }
            userId = signIn.user.id;
        } else {
            // Block new account creation when signups are disabled.
            const allowed = await isSignupAllowed();
            if (!allowed) {
                return Response.json(
                    { error: "Signups are disabled. Contact the administrator." },
                    { status: 403 },
                );
            }
            if (!name) {
                return Response.json(
                    { error: "Missing required field: name (required for new accounts)" },
                    { status: 400 },
                );
            }
            const created = await getAuth().api.signUpEmail({
                body: { name, email, password },
            });
            if (!created?.user?.id) {
                return Response.json({ error: "Failed to create user" }, { status: 500 });
            }
            userId = created.user.id;
        }

        // Generate a fresh API key for CLI use
        const { randomBytes } = await import("crypto");
        const key = randomBytes(32).toString("hex");

        // Hash key using SHA-256 + base64url (matches better-auth's defaultKeyHasher)
        const keyHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
        const hashedKey = btoa(String.fromCharCode(...new Uint8Array(keyHashBuf)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");

        await getKysely().deleteFrom("apikey").where("userId", "=", userId).where("name", "=", "cli").execute();

        const now = new Date().toISOString();
        await getKysely()
            .insertInto("apikey")
            .values({
                id: crypto.randomUUID(),
                name: "cli",
                start: key.slice(0, 8),
                prefix: null,
                key: hashedKey,
                userId,
                refillInterval: null,
                refillAmount: null,
                lastRefillAt: null,
                enabled: 1,
                rateLimitEnabled: getApiKeyRateLimitConfig().enabled ? 1 : 0,
                rateLimitTimeWindow: getApiKeyRateLimitConfig().enabled
                    ? getApiKeyRateLimitConfig().timeWindow
                    : null,
                rateLimitMax: getApiKeyRateLimitConfig().enabled
                    ? getApiKeyRateLimitConfig().maxRequests
                    : null,
                requestCount: 0,
                remaining: null,
                lastRequest: null,
                expiresAt: null,
                createdAt: now,
                updatedAt: now,
                permissions: null,
                metadata: null,
            })
            .execute();

        return Response.json({ ok: true, key });
    }

    return undefined;
};
