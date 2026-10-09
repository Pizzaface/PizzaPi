import { createHmac } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";

const mockGetActiveRelaySessionUserId = mock(
    (_sessionId: string): Promise<string | null> => Promise.resolve("u-1"),
);
const mockGetRunnerData = mock(
    (runnerId: string): Promise<{ runnerId: string; userId: string } | null> =>
        Promise.resolve({ runnerId, userId: "u-1" }),
);

mock.module("../sessions/store.js", () => ({
    getActiveRelaySessionUserId: mockGetActiveRelaySessionUserId,
}));

mock.module("../ws/sio-registry.js", () => ({
    emitToRunner: mock(() => {}),
    getRunnerData: mockGetRunnerData,
}));

const {
    createTunnelToken,
    getAuthTunnelBasePath,
    verifyTunnelToken,
    assertTunnelTokenStillValid,
    TUNNEL_TOKEN_AUD,
    tunnelTokenAgeMs,
} = await import("./tunnel-token.js");

// Helpers to manipulate env vars during a test
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

describe("tunnel token — basic sign/verify", () => {
    test("creates scoped signed path tokens with v2 claims", () => {
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
                aud: TUNNEL_TOKEN_AUD,
            });
            expect(typeof payload?.iat).toBe("number");
            expect(typeof payload?.kid).toBe("string");
        });
    });

    test("rejects tampered tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken(
                { userId: "u-1", sessionId: "s-1", port: 3000 },
                1_000,
            );
            expect(verifyTunnelToken(`${token}x`, 1_000)).toBeNull();
        });
    });

    test("rejects expired tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken(
                { userId: "u-1", sessionId: "s-1", port: 3000 },
                1_000,
            );
            expect(verifyTunnelToken(token, 3_601_000)).toBeNull();
        });
    });
});

describe("tunnel token — dedicated secret", () => {
    test("signs with PIZZAPI_TUNNEL_TOKEN_SECRET when set", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-aaaaaaaaaaaaaaaaaaaaaa" });
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: "tunnel-secret-bbbbbbbbbbbbbbbbbbbb" }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
                // Verifies with tunnel secret
                expect(verifyTunnelToken(token, 1_000)).not.toBeNull();
            });
        });
    });

    test("falls back to auth secret when PIZZAPI_TUNNEL_TOKEN_SECRET is unset", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-fallback-aaaaaaaaaaaaa" });
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: undefined }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
                expect(verifyTunnelToken(token, 1_000)).not.toBeNull();
            });
        });
    });

    test("token minted with auth secret is rejected when a different dedicated secret is active", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-cccccccccccccccccccc" });

        // Mint with auth secret (no dedicated secret)
        let mintedToken: string;
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: undefined, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
                mintedToken = token;
            });
        });

        // Verify with a completely different dedicated secret (no previous set)
        withEnv({
            PIZZAPI_TUNNEL_TOKEN_SECRET: "dedicated-secret-dddddddddddddddddddd",
            PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined,
        }, () => {
            runWithAuthContext(ctx, () => {
                // The token's kid was derived from the auth secret, which
                // doesn't match the now-active dedicated secret (or any
                // previous secret, since none is set). It should be rejected.
                expect(verifyTunnelToken(mintedToken!, 1_000)).toBeNull();
            });
        });
    });
});

describe("tunnel token — aud validation", () => {
    test("rejects token with wrong aud", () => {
        const secret = "aud-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
            // Decode, tamper aud, then re-sign with the same secret used to mint
            // so the signature matches the tampered payload — isolating aud
            // rejection from an incidental signature mismatch.
            const [encoded] = token.split(".");
            const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
            payload.aud = "evil:audience";
            const tamperedEncoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
            const tamperedSignature = createHmac("sha256", secret).update(tamperedEncoded).digest("base64url");
            const tamperedToken = `${tamperedEncoded}.${tamperedSignature}`;
            expect(verifyTunnelToken(tamperedToken, 1_000)).toBeNull();
        });
    });
});

describe("tunnel token — legacy (no-kid) path removed", () => {
    test("rejects a correctly-signed token that lacks aud/kid", () => {
        const secret = "legacy-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaa";
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret });
        runWithAuthContext(ctx, () => {
            // Hand-build a pre-v2 payload: no aud, iat or kid, just the original
            // v1 claims, signed correctly with the current secret.
            const payload = { v: 1, userId: "u-1", sessionId: "s-1", port: 3000, exp: 3_601 };
            const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
            const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
            const legacyToken = `${encodedPayload}.${signature}`;
            expect(verifyTunnelToken(legacyToken, 1_000)).toBeNull();
        });
    });
});

describe("tunnel token — kid validation", () => {
    test("rejects token with mismatched kid when no previous secret", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-aaaaaaaaaaaaaaaaaaaaaa" });
        withEnv({
            PIZZAPI_TUNNEL_TOKEN_SECRET: "secret-A-aaaaaaaaaaaaaaaaaaaaaaaaaaa",
            PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined,
        }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);

                // Now switch to a different active secret (no previous)
                withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: "secret-B-bbbbbbbbbbbbbbbbbbbbbbbbbbb" }, () => {
                    // kid won't match either current or previous → rejected
                    expect(verifyTunnelToken(token, 1_000)).toBeNull();
                });
            });
        });
    });
});

describe("tunnel token — rotation (previous secret)", () => {
    test("accepts token signed by previous secret during rotation window", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-aaaaaaaaaaaaaaaaaaaaaa" });

        const oldSecret = "old-secret-cccccccccccccccccccccccccccc";
        const newSecret = "new-secret-dddddddddddddddddddddddddddd";

        // Mint with old secret
        let oldToken: string;
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: oldSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
                oldToken = token;
            });
        });

        // Verify with new secret + old as previous → accepted
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: newSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: oldSecret }, () => {
            runWithAuthContext(ctx, () => {
                expect(verifyTunnelToken(oldToken!, 1_000)).not.toBeNull();
            });
        });
    });

    test("previous-key tokens stay valid for their full requested lifetime (up to 168 h), not 1 h", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-aaaaaaaaaaaaaaaaaaaaaa" });
        const oldSecret = "old-secret-gggggggggggggggggggggggggggg";
        const newSecret = "new-secret-hhhhhhhhhhhhhhhhhhhhhhhhhhhh";
        const HOUR = 3600 * 1000;
        // Longest lifetime handleTunnelTokenMint accepts (LABEL_MAX_TTL_HOURS).
        const maxTtlMs = 168 * HOUR;

        let oldToken: string;
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: oldSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                oldToken = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000, ttlMs: maxTtlMs }, 0).token;
            });
        });

        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: newSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: oldSecret }, () => {
            runWithAuthContext(ctx, () => {
                // Well past the 1 h the rotation guide used to assume.
                expect(verifyTunnelToken(oldToken!, 2 * HOUR)).not.toBeNull();
                expect(verifyTunnelToken(oldToken!, maxTtlMs - HOUR)).not.toBeNull();
                expect(verifyTunnelToken(oldToken!, maxTtlMs + 1_000)).toBeNull();
            });
        });
        // Dropping the previous secret early cuts those live links off.
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: newSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                expect(verifyTunnelToken(oldToken!, 2 * HOUR)).toBeNull();
            });
        });
    });

    test("rejects previous-key token once previous secret is removed", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:", secret: "auth-secret-aaaaaaaaaaaaaaaaaaaaaa" });

        const oldSecret = "old-secret-eeeeeeeeeeeeeeeeeeeeeeeeeeee";
        const newSecret = "new-secret-ffffffffffffffffffffffffffff";

        let oldToken: string;
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: oldSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 1_000);
                oldToken = token;
            });
        });

        // Verify with new secret only (no previous) → kid mismatch → rejected
        withEnv({ PIZZAPI_TUNNEL_TOKEN_SECRET: newSecret, PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS: undefined }, () => {
            runWithAuthContext(ctx, () => {
                expect(verifyTunnelToken(oldToken!, 1_000)).toBeNull();
            });
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

describe("tunnelTokenAgeMs (F04 exposure binding)", () => {
    test("measures age from iat so the runner can reject tokens minted for an earlier exposure", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 10_000_000);
            const payload = verifyTunnelToken(token, 10_000_000)!;
            expect(tunnelTokenAgeMs(payload, 10_000_000 + 90_000)).toBe(90_000);
        });
    });

    test("ages new tokens with millisecond precision so a link minted just after a close is not mistaken for an older one", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createTunnelToken({ userId: "u-1", sessionId: "s-1", port: 3000 }, 10_000_750);
            const payload = verifyTunnelToken(token, 10_000_750)!;
            // Whole-second iat alone would report 1 000 ms.
            expect(tunnelTokenAgeMs(payload, 10_001_000)).toBe(250);
        });
    });

    test("ignores an iatMs that disagrees with the whole-second iat", () => {
        expect(tunnelTokenAgeMs({ v: 1, userId: "u", sessionId: "s", port: 1, exp: 99_999, iat: 10_000, iatMs: 50 }, 10_000_500)).toBe(500);
    });

    test("legacy tokens without iat are aged from their fixed 1 h lifetime", () => {
        expect(tunnelTokenAgeMs({ v: 1, userId: "u", sessionId: "s", port: 1, exp: 7_200 }, 7_200_000)).toBe(3_600_000);
    });

    test("never reports a negative age", () => {
        expect(tunnelTokenAgeMs({ v: 1, userId: "u", sessionId: "s", port: 1, exp: 99_999, iat: 5_000 }, 1_000)).toBe(0);
    });
});
