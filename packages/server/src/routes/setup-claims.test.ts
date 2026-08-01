/**
 * Route-level tests for setup-claim endpoints.
 *
 * These exist specifically to catch routing regressions that store-level
 * tests can't see: GET /api/setup-claim/:token is a one-shot redeem for the
 * CLI, and GET /api/setup-claim-info/:token must never fall through to it, and must
 * live outside the /api/setup-claim/ prefix so older relays (which parse the
 * poll token with split("/")[0]) can't mis-route it into the consuming handler.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { runAllMigrations } from "../migrations.js";
import { createSetupClaim, approveSetupClaim } from "../setup-claims.js";
import { handleSetupClaimsRoute } from "./setup-claims.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-setup-claims-routes-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function get(path: string): { req: Request; url: URL } {
    const url = new URL(`http://localhost:7492${path}`);
    return { req: new Request(url, { method: "GET" }), url };
}

describe("setup-claim routes", () => {
    test("GET /api/setup-claim-info/:token never consumes the one-shot key, and the CLI poll route still redeems afterwards", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            const approve = await approveSetupClaim(token, "user-route", "Route");
            expect(approve).not.toBeNull();

            // Simulate the browser re-opening the confirm screen after approval
            // (deep link revisited, StrictMode double-invoke, etc.) — hit /info twice.
            for (let i = 0; i < 2; i++) {
                const { req, url } = get(`/api/setup-claim-info/${token}`);
                const res = await handleSetupClaimsRoute(req, url);
                expect(res).toBeDefined();
                const body = (await res!.json()) as { status: string; label?: string; apiKey?: string };
                expect(body.status).toBe("approved");
                expect(body.label).toBe("docker-demo-runner");
                expect(body.apiKey).toBeUndefined();
            }

            // The CLI's plain poll route must still redeem successfully: first
            // call returns the key, second call reports redeemed.
            const { req: pollReq1, url: pollUrl1 } = get(`/api/setup-claim/${token}`);
            const pollRes1 = await handleSetupClaimsRoute(pollReq1, pollUrl1);
            const pollBody1 = (await pollRes1!.json()) as { status: string; apiKey?: string };
            expect(pollBody1.status).toBe("approved");
            expect(pollBody1.apiKey).toBe(approve!.apiKey);

            const { req: pollReq2, url: pollUrl2 } = get(`/api/setup-claim/${token}`);
            const pollRes2 = await handleSetupClaimsRoute(pollReq2, pollUrl2);
            const pollBody2 = (await pollRes2!.json()) as { status: string; apiKey?: string };
            expect(pollBody2.status).toBe("redeemed");
            expect(pollBody2.apiKey).toBeUndefined();
        });
    });

    test("GET .../token (no info route) is still the one-shot redeem for a pending claim", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const { req, url } = get(`/api/setup-claim/${token}`);
            const res = await handleSetupClaimsRoute(req, url);
            const body = (await res!.json()) as { status: string };
            expect(body.status).toBe("pending");
        });
    });

    // Cross-version safety. The UI ships as its own image and will meet older
    // relays, which resolve the poll token as
    // `pathname.slice("/api/setup-claim/".length).split("/")[0]` — meaning a
    // NESTED `/api/setup-claim/:token/info` arrives at their consuming handler
    // with a valid token and silently redeems an approved claim. Keeping the
    // info route under its own prefix is what prevents that, so pin it here:
    // if someone "tidies" the path back under /api/setup-claim/, this fails.
    test("the info route lives outside the /api/setup-claim/ prefix (old relays would mis-route a nested path)", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            await approveSetupClaim(token, "user-route", "Route");

            // The nested path must NOT be served as an info read here either —
            // this server answers it with the redeem handler, exactly as an old
            // relay would, which is precisely why the UI must not request it.
            const nested = get(`/api/setup-claim/${token}/info`);
            const nestedRes = await handleSetupClaimsRoute(nested.req, nested.url);
            const nestedBody = (await nestedRes!.json()) as { status?: string; apiKey?: string };
            expect(nestedBody.apiKey).toBeDefined(); // consumed — proves the hazard is real

            // ...and the dedicated prefix is the safe read that the UI uses.
            const { token: token2 } = await createSetupClaim("http://localhost:7492", "docker-demo-runner");
            await approveSetupClaim(token2, "user-route", "Route");
            const info = get(`/api/setup-claim-info/${token2}`);
            const infoRes = await handleSetupClaimsRoute(info.req, info.url);
            const infoBody = (await infoRes!.json()) as { status: string; apiKey?: string };
            expect(infoBody.apiKey).toBeUndefined();
            expect(infoBody.status).toBe("approved");
        });
    });
});
