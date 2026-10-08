import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext } from "./auth.js";
import { hashApiKey } from "./api-key-hash.js";
import { runAllMigrations } from "./migrations.js";
import {
    createSetupClaim,
    pollSetupClaim,
    approveSetupClaim,
    getSetupClaimInfo,
    normalizeSetupClaimRelayUrl,
    SetupClaimRejectedError,
    SETUP_CLAIM_RELAY_URL_MAX_LENGTH,
} from "./setup-claims.js";
import { runWithAuthContext } from "./auth.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-setup-claims-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("setup-claims store", () => {
    test("creates a pending claim", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token, expiresAt } = await createSetupClaim("http://localhost:7492");
            expect(token.length).toBeGreaterThan(30);
            expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

            const status = await pollSetupClaim(token);
            expect(status).not.toBeNull();
            expect(status!.status).toBe("pending");
            expect(status!.apiKey).toBeUndefined();
        });
    });

    test("approving stores an API key and polling redeems it", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-1", "Jordan");
            expect(approve).not.toBeNull();
            expect(approve!.apiKey.length).toBe(64);

            const first = await pollSetupClaim(token);
            expect(first!.status).toBe("approved");
            expect(first!.apiKey).toBe(approve!.apiKey);

            const second = await pollSetupClaim(token);
            expect(second!.status).toBe("redeemed");
            expect(second!.apiKey).toBeUndefined();
        });
    });

    test("approval stores the shared better-auth API key hash", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-hash", "Hash");
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const row = await getKysely()
                .selectFrom("apikey")
                .select(["key"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .executeTakeFirstOrThrow();
            expect(row.key).toBe(await hashApiKey(approve!.apiKey));
        });
    });

    // B-016: redemption must clear the plaintext key from the row in the same
    // atomic UPDATE that marks it redeemed — no redeemed-but-key-still-present
    // window for DB backups/readers.
    test("redemption clears the stored apiKey column while still serving the caller", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-clear", "Clear");
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const before = await getKysely()
                .selectFrom("setup_claim")
                .select(["apiKey", "status"])
                .where("id", "=", token)
                .executeTakeFirstOrThrow();
            expect(before.status).toBe("approved");
            expect(before.apiKey).toBe(approve!.apiKey);

            // Legitimate poller still receives the key.
            const first = await pollSetupClaim(token);
            expect(first!.status).toBe("approved");
            expect(first!.apiKey).toBe(approve!.apiKey);

            // But the row no longer holds it — cleared atomically with the redeem.
            const after = await getKysely()
                .selectFrom("setup_claim")
                .select(["apiKey", "status", "redeemedAt"])
                .where("id", "=", token)
                .executeTakeFirstOrThrow();
            expect(after.status).toBe("redeemed");
            expect(after.apiKey).toBeNull();
            expect(after.redeemedAt).not.toBeNull();

            // Second poll reports redeemed and never re-serves the key.
            const second = await pollSetupClaim(token);
            expect(second!.status).toBe("redeemed");
            expect(second!.apiKey).toBeUndefined();
        });
    });

    test("concurrent polls serve the key exactly once", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-race", "Race");
            expect(approve).not.toBeNull();

            const results = await Promise.all([
                pollSetupClaim(token),
                pollSetupClaim(token),
                pollSetupClaim(token),
            ]);
            const served = results.filter((r) => r!.apiKey === approve!.apiKey);
            expect(served.length).toBe(1);
            for (const r of results.filter((r) => r!.apiKey !== approve!.apiKey)) {
                expect(r!.apiKey).toBeUndefined();
                expect(r!.status).toBe("redeemed");
            }
        });
    });

    test("unknown token returns null", async () => {
        await runWithAuthContext(authContext, async () => {
            const status = await pollSetupClaim("definitely-not-a-token");
            expect(status).toBeNull();
        });
    });

    test("expired claims are rejected", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            // Force expiry by rewriting the row.
            const { getKysely } = await import("./auth.js");
            await getKysely()
                .updateTable("setup_claim")
                .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
                .where("id", "=", token)
                .execute();

            const status = await pollSetupClaim(token);
            expect(status!.status).toBe("expired");
        });
    });

    test("approved key is time-limited and not hand-rolled with rateLimitEnabled 0", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-ttl", "Dana");
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const row = await getKysely()
                .selectFrom("apikey")
                .select(["expiresAt"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .executeTakeFirst();
            expect(row).toBeTruthy();
            // Old inline insert used expiresAt: null (permanent). Minting via
            // mintEphemeralApiKey gives it a real, future expiry.
            expect(row!.expiresAt).not.toBeNull();
            expect(new Date(row!.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
        });
    });

    test("minted key lifetime is capped to the approver's maxTtlSeconds", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const capSeconds = 3600; // 1h — far below the 365d default
            const approve = await approveSetupClaim(token, "user-cap", "Cap", capSeconds);
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const row = await getKysely()
                .selectFrom("apikey")
                .select(["expiresAt"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .executeTakeFirst();
            const expMs = new Date(row!.expiresAt as string).getTime();
            // Never longer than the cap (+ small skew), and clearly not the default.
            expect(expMs).toBeLessThanOrEqual(Date.now() + (capSeconds + 60) * 1000);
            expect(expMs).toBeLessThan(Date.now() + 2 * 24 * 60 * 60 * 1000);
        });
    });

    test("concurrent two-user approval: exactly one wins, loser rejected, loser key revoked", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            // Both approvers start from the same pending claim. Both pass the
            // read + mint; the CAS lets exactly one flip pending→approved.
            const [a, b] = await Promise.all([
                approveSetupClaim(token, "user-race-1", "RacerOne"),
                approveSetupClaim(token, "user-race-2", "RacerTwo"),
            ]);
            const winners = [a, b].filter((r) => r !== null);
            expect(winners.length).toBe(1);

            // Exactly one surviving api key for this claim — the winner's.
            // (Both racers mint with the same keyName; a leaked loser key
            // would show up as a second row.)
            const { getKysely } = await import("./auth.js");
            const rows = await getKysely()
                .selectFrom("apikey")
                .select(["start", "userId"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .execute();
            expect(rows.length).toBe(1);
            expect(rows[0]!.start).toBe(winners[0]!.apiKey.slice(0, 8));

            // The winner's key is what the CLI redeems.
            const claim = await pollSetupClaim(token);
            expect(claim!.status).toBe("approved");
            expect(claim!.apiKey).toBe(winners[0]!.apiKey);

            // And the loser can't approve afterwards either (still single winner).
            const late = await approveSetupClaim(token, "user-race-3", "Late");
            expect(late).toBeNull();
            const rowsAfter = await getKysely()
                .selectFrom("apikey")
                .select(["start"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .execute();
            expect(rowsAfter.length).toBe(1);
        });
    });

    test("approval fails for already-approved claims", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const first = await approveSetupClaim(token, "user-1", "Jordan");
            expect(first).not.toBeNull();
            const second = await approveSetupClaim(token, "user-2", "Other");
            expect(second).toBeNull();
        });
    });

    test("label is trimmed, persisted, and returned on poll", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "  docker-demo-runner  ");
            const status = await pollSetupClaim(token);
            expect(status!.label).toBe("docker-demo-runner");
        });
    });

    test("hostile label input is stripped to a safe charset and truncated", async () => {
        await runWithAuthContext(authContext, async () => {
            const hostile = "<script>alert(1)</script>\x00\x07" + "a".repeat(100);
            const { token } = await createSetupClaim("http://localhost:7492", hostile);
            const status = await pollSetupClaim(token);
            expect(status!.label).toBeDefined();
            expect(status!.label!.length).toBeLessThanOrEqual(64);
            // Only letters, digits, space, -, _, . may survive.
            expect(status!.label!).toMatch(/^[a-zA-Z0-9 _.-]*$/);
        });
    });

    test("whitespace-only label is treated as no label", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "   ");
            const status = await pollSetupClaim(token);
            expect(status!.label).toBeUndefined();
        });
    });

    test("no label still behaves exactly as before (relayUrl-only call)", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token, expiresAt } = await createSetupClaim("http://localhost:7492");
            expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
            const status = await pollSetupClaim(token);
            expect(status!.label).toBeUndefined();

            const approve = await approveSetupClaim(token, "user-nolabel", "NoLabel");
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const row = await getKysely()
                .selectFrom("apikey")
                .select(["name"])
                .where("name", "=", `setup-claim-${token.slice(0, 8)}`)
                .executeTakeFirst();
            expect(row).toBeTruthy();

            const firstPoll = await pollSetupClaim(token);
            expect(firstPoll!.status).toBe("approved");
            expect(firstPoll!.apiKey).toBe(approve!.apiKey);

            const redeemed = await pollSetupClaim(token);
            expect(redeemed!.status).toBe("redeemed");
        });
    });

    test("approving a labeled claim names the minted key after the label", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            const approve = await approveSetupClaim(token, "user-label", "Labelled");
            expect(approve).not.toBeNull();

            const { getKysely } = await import("./auth.js");
            const row = await getKysely()
                .selectFrom("apikey")
                .select(["name"])
                .where("name", "=", "runner-docker-demo-runner")
                .executeTakeFirst();
            expect(row).toBeTruthy();
        });
    });

    test("label survives the approve -> poll -> redeem cycle", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            await approveSetupClaim(token, "user-cycle", "Cycle");

            const first = await pollSetupClaim(token);
            expect(first!.status).toBe("approved");
            expect(first!.label).toBe("docker-demo-runner");

            const second = await pollSetupClaim(token);
            expect(second!.status).toBe("redeemed");
            expect(second!.label).toBe("docker-demo-runner");
        });
    });

    // Regression: the web UI reads label/status via getSetupClaimInfo (the
    // /info route), which must be safe to call after approval without
    // disturbing the CLI's one-shot redeem via pollSetupClaim.
    test("getSetupClaimInfo never leaks the key and never redeems an approved claim", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            const approve = await approveSetupClaim(token, "user-info", "Info");
            expect(approve).not.toBeNull();

            const info = await getSetupClaimInfo(token);
            expect(info).not.toBeNull();
            expect(info!.status).toBe("approved");
            expect(info!.label).toBe("docker-demo-runner");
            expect((info as unknown as { apiKey?: string }).apiKey).toBeUndefined();

            // The CLI's poll must still work: first call redeems and returns the key,
            // second call reports redeemed. getSetupClaimInfo must not have consumed it.
            const firstPoll = await pollSetupClaim(token);
            expect(firstPoll!.status).toBe("approved");
            expect(firstPoll!.apiKey).toBe(approve!.apiKey);

            const secondPoll = await pollSetupClaim(token);
            expect(secondPoll!.status).toBe("redeemed");
            expect(secondPoll!.apiKey).toBeUndefined();
        });
    });

    test("repeated getSetupClaimInfo reads on an approved claim never redeem it", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            await approveSetupClaim(token, "user-repeat", "Repeat");

            for (let i = 0; i < 5; i++) {
                const info = await getSetupClaimInfo(token);
                expect(info!.status).toBe("approved");
            }

            // Still approved (not redeemed) after all those reads — the CLI poll
            // is the only thing allowed to consume it.
            const info = await getSetupClaimInfo(token);
            expect(info!.status).toBe("approved");
        });
    });

    test("getSetupClaimInfo returns null for an unknown token", async () => {
        await runWithAuthContext(authContext, async () => {
            const info = await getSetupClaimInfo("definitely-not-a-token");
            expect(info).toBeNull();
        });
    });
});

// F08: unauthenticated claim creation must be bounded.
describe("setup-claims admission limits", () => {
    async function countRows(): Promise<number> {
        const { getKysely } = await import("./auth.js");
        const rows = await getKysely().selectFrom("setup_claim").select("id").execute();
        return rows.length;
    }
    async function countUnexpired(): Promise<number> {
        const { getKysely } = await import("./auth.js");
        const rows = await getKysely()
            .selectFrom("setup_claim")
            .select("id")
            .where("expiresAt", ">", new Date().toISOString())
            .execute();
        return rows.length;
    }

    test("rejects non-http(s), credential-bearing, and oversized relay URLs without writing a row", async () => {
        await runWithAuthContext(authContext, async () => {
            const before = await countRows();
            for (const bad of [
                "",
                "not a url",
                "ftp://relay.example.com",
                "javascript:alert(1)",
                "file:///etc/passwd",
                "https://user:pass@relay.example.com",
                `https://relay.example.com/${"a".repeat(SETUP_CLAIM_RELAY_URL_MAX_LENGTH)}`,
            ]) {
                const err = await createSetupClaim(bad).catch((e) => e);
                expect(err).toBeInstanceOf(SetupClaimRejectedError);
                expect((err as SetupClaimRejectedError).reason).toBe("invalid_relay_url");
            }
            expect(await countRows()).toBe(before);
            expect(normalizeSetupClaimRelayUrl("  https://relay.example.com:7492  ")).toBe("https://relay.example.com:7492");
        });
    });

    test("enforces the global outstanding-claim quota and writes nothing once exceeded", async () => {
        await runWithAuthContext(authContext, async () => {
            const cap = (await countUnexpired()) + 2;
            await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap });
            await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap });
            const before = await countRows();

            const err = await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap }).catch((e) => e);
            expect(err).toBeInstanceOf(SetupClaimRejectedError);
            expect((err as SetupClaimRejectedError).reason).toBe("quota_exceeded");
            expect(await countRows()).toBe(before);
        });
    });

    test("expired claims free quota and long-expired rows are purged on create", async () => {
        await runWithAuthContext(authContext, async () => {
            const { getKysely } = await import("./auth.js");
            const cap = (await countUnexpired()) + 1;
            const { token: filler } = await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap });
            await expect(createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap })).rejects.toBeInstanceOf(SetupClaimRejectedError);

            // Recently expired: no longer counts against the quota, but is kept
            // so a polling CLI still sees `expired` instead of 404.
            const recentlyExpired = new Date(Date.now() - 1000).toISOString();
            await getKysely().updateTable("setup_claim").set({ expiresAt: recentlyExpired }).where("id", "=", filler).execute();
            const { token: next } = await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap });
            expect((await pollSetupClaim(filler))!.status).toBe("expired");

            // Long-expired: physically deleted by the next create.
            const longExpired = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            await getKysely().updateTable("setup_claim").set({ expiresAt: longExpired }).where("id", "in", [filler, next]).execute();
            await createSetupClaim("http://localhost:7492", null, { maxOutstanding: cap });
            const remaining = await getKysely().selectFrom("setup_claim").select("id").where("id", "in", [filler, next]).execute();
            expect(remaining).toHaveLength(0);
        });
    });
});
