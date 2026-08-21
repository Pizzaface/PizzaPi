import { describe, expect, test } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { createAttachmentToken, verifyAttachmentToken, ATTACHMENT_TOKEN_TTL_MS } from "./attachment-token.js";

describe("attachment token", () => {
    test("creates signed token with correct payload and expiry", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token, expiresAt } = createAttachmentToken(
                { userId: "u-1", attachmentId: "att-1" },
                1_000,
            );
            expect(expiresAt).toBe(new Date(1_000 + ATTACHMENT_TOKEN_TTL_MS).toISOString());

            const payload = verifyAttachmentToken(token, 1_000);
            expect(payload).toMatchObject({
                v: 1,
                userId: "u-1",
                attachmentId: "att-1",
            });
            expect(payload!.exp).toBe(Math.floor((1_000 + ATTACHMENT_TOKEN_TTL_MS) / 1000));
        });
    });

    test("rejects expired tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createAttachmentToken(
                { userId: "u-1", attachmentId: "att-1" },
                1_000,
            );
            // Verify at time after expiry
            expect(verifyAttachmentToken(token, 1_000 + ATTACHMENT_TOKEN_TTL_MS + 1_000)).toBeNull();
        });
    });

    test("rejects tampered tokens", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createAttachmentToken(
                { userId: "u-1", attachmentId: "att-1" },
                1_000,
            );
            expect(verifyAttachmentToken(`${token}x`, 1_000)).toBeNull();
            expect(verifyAttachmentToken(token.slice(0, -1), 1_000)).toBeNull();
            // Tamper the payload portion
            const [payload, sig] = token.split(".");
            const tamperedPayload = Buffer.from(JSON.stringify({ v: 1, userId: "u-evil", attachmentId: "att-1", exp: 9999999 })).toString("base64url");
            expect(verifyAttachmentToken(`${tamperedPayload}.${sig}`, 1_000)).toBeNull();
        });
    });

    test("rejects tokens with wrong number of segments", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            expect(verifyAttachmentToken("onlyone", 1_000)).toBeNull();
            expect(verifyAttachmentToken("a.b.c", 1_000)).toBeNull();
        });
    });

    test("rejects tokens with wrong version", () => {
        const ctx = createTestAuthContext({ dbPath: ":memory:" });
        runWithAuthContext(ctx, () => {
            const { token } = createAttachmentToken(
                { userId: "u-1", attachmentId: "att-1" },
                1_000,
            );
            // Mutate v field manually — tamper detection should catch it
            const [encodedPayload] = token.split(".");
            const raw = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
            raw.v = 2;
            const newEncoded = Buffer.from(JSON.stringify(raw)).toString("base64url");
            // Signature won't match — should be rejected
            expect(verifyAttachmentToken(`${newEncoded}.invalidsig`, 1_000)).toBeNull();
        });
    });
});
