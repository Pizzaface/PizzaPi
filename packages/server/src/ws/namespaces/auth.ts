// ============================================================================
// auth.ts — Socket.IO authentication middleware factories
//
// Two middleware factories:
//   1. apiKeyAuthMiddleware()     — for /relay and /runner namespaces
//   2. sessionCookieAuthMiddleware() — for /viewer, /terminal, /hub namespaces
//
// Each validates credentials from the Socket.IO handshake and populates
// socket.data with userId and userName on success.
// ============================================================================

import type { Socket } from "socket.io";
import { auth, kysely } from "../../auth.js";

/**
 * Middleware for /relay and /runner namespaces.
 *
 * Extracts the API key from `socket.handshake.auth.apiKey`, validates it
 * via better-auth's `verifyApiKey`, and sets `socket.data.userId` and
 * `socket.data.userName`.
 *
 * Rejects with `next(new Error("unauthorized"))` if the key is missing or invalid.
 */
export function apiKeyAuthMiddleware() {
    return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            const apiKey = socket.handshake.auth?.apiKey;
            if (typeof apiKey !== "string" || !apiKey) {
                return next(new Error("unauthorized"));
            }

            const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
            if (!result.valid || !result.key?.userId) {
                return next(new Error("unauthorized"));
            }

            const userId = result.key.userId;
            const row = await kysely
                .selectFrom("user")
                .select("name")
                .where("id", "=", userId)
                .executeTakeFirst();

            socket.data.userId = userId;
            socket.data.userName = row?.name ?? userId;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    };
}

/**
 * Middleware for /viewer, /terminal, and /hub namespaces.
 *
 * Extracts the session cookie from `socket.handshake.headers.cookie`,
 * validates the session via better-auth's `getSession()`, and sets
 * `socket.data.userId` and `socket.data.userName`.
 *
 * Rejects with `next(new Error("unauthorized"))` if no valid session exists.
 */
export function sessionCookieAuthMiddleware() {
    return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            const cookieHeader = socket.handshake.headers.cookie;
            if (!cookieHeader) {
                return next(new Error("unauthorized"));
            }

            const headers = new Headers();
            headers.set("cookie", cookieHeader);

            const session = await auth.api.getSession({ headers });
            if (!session?.user?.id) {
                return next(new Error("unauthorized"));
            }

            socket.data.userId = session.user.id;
            socket.data.userName = session.user.name ?? session.user.id;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    };
}
