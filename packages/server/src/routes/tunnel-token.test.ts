import { describe, expect, mock, test } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";

const mockGetActiveRelaySessionUserId = mock(
    (sessionId: string): Promise<string | null> => Promise.resolve("u-1"),
);
const mockGetRunnerData = mock(
    (runnerId: string): Promise<{ runnerId: string; userId: string } | null> =>
        Promise.resolve({ runnerId, userId: "u-1" }),
);

mock.module("../sessions/store.js", () => ({
    getActiveRelaySessionUserId: mockGetActiveRelaySessionUserId,
}));

mock.module("../ws/sio-registry.js", () => ({
    getRunnerData: mockGetRunnerData,
}));

const {
    createTunnelToken,
    getAuthTunnelBasePath,
    verifyTunnelToken,
    assertTunnelTokenStillValid,
} = await import("./tunnel-token.js");

describe("tunnel token", () => {
    test("creates scoped signed path tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token, expiresAt } = createTunnelToken(
                { userId: "u-1", sessionId: "s-1", port: 3000 },
                1_000,
            );
            expect(expiresAt).toBe(new Date(3_601_000).toISOString());
            expect(getAuthTunnelBasePath(token, "s-1", 3000)).toStartWith(
                "/api/tunnel/auth/",
            );

            const payload = verifyTunnelToken(token, 1_000);
            expect(payload).toMatchObject({
                v: 1,
                userId: "u-1",
                sessionId: "s-1",
                port: 3000,
            });
        });
    });

    test("rejects tampered and expired tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken(
                { userId: "u-1", sessionId: "s-1", port: 3000 },
                1_000,
            );
            expect(verifyTunnelToken(`${token}x`, 1_000)).toBeNull();
            expect(verifyTunnelToken(token, 3_601_000)).toBeNull();
        });
    });
});

describe("assertTunnelTokenStillValid", () => {
    test("accepts tokens whose session is still active and owned by the same user", async () => {
        mockGetActiveRelaySessionUserId.mockImplementation(() =>
            Promise.resolve("u-1"),
        );
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "s-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).resolves.toBeUndefined();
    });

    test("rejects tokens for ended or re-owned sessions", async () => {
        mockGetActiveRelaySessionUserId.mockImplementation(() =>
            Promise.resolve("u-2"),
        );
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "s-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).rejects.toThrow("Tunnel token revoked");

        mockGetActiveRelaySessionUserId.mockImplementation(() =>
            Promise.resolve(null),
        );
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "s-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).rejects.toThrow("Tunnel token revoked");
    });

    test("accepts runner-scoped tokens only when runner exists and is owned by the same user", async () => {
        mockGetRunnerData.mockImplementation(() =>
            Promise.resolve({ runnerId: "r-1", userId: "u-1" }),
        );
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "runner:r-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).resolves.toBeUndefined();

        mockGetRunnerData.mockImplementation(() =>
            Promise.resolve({ runnerId: "r-1", userId: "u-2" }),
        );
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "runner:r-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).rejects.toThrow("Tunnel token revoked");

        mockGetRunnerData.mockImplementation(() => Promise.resolve(null));
        await expect(
            assertTunnelTokenStillValid({
                v: 1,
                userId: "u-1",
                sessionId: "runner:r-1",
                port: 3000,
                exp: 1_000_000,
            }),
        ).rejects.toThrow("Tunnel token revoked");
    });
});
