import { describe, expect, test } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { createTunnelToken, getAuthTunnelBasePath, verifyTunnelToken } from "./tunnel-token.js";

describe("tunnel token", () => {
    test("creates scoped signed path tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token, expiresAt } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
            expect(expiresAt).toBe(new Date(3_601_000).toISOString());
            expect(getAuthTunnelBasePath(token, "s-1", 3000)).toStartWith("/api/tunnel/auth/");

            const payload = verifyTunnelToken(token, 1_000);
            expect(payload).toMatchObject({ v: 1, userId: "u-1", sessionId: "s-1", port: 3000 });
        });
    });

    test("rejects tampered and expired tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
            expect(verifyTunnelToken(`${token}x`, 1_000)).toBeNull();
            expect(verifyTunnelToken(token, 3_601_000)).toBeNull();
        });
    });
});
