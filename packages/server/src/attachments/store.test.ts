import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
    sanitizeFilename,
    attachmentMaxFileSizeBytes,
    storeSessionAttachment,
    _getAttachmentCount,
    _clearAllAttachments,
} from "./store.js";

describe("sanitizeFilename", () => {
    test("preserves safe characters", () => {
        expect(sanitizeFilename("file.txt")).toBe("file.txt");
    });
    test("replaces spaces with underscores", () => {
        expect(sanitizeFilename("my file.txt")).toBe("my_file.txt");
    });
});

describe("attachment eviction", () => {
    const originalMaxAttachments = process.env.PIZZAPI_MAX_ATTACHMENTS;

    beforeEach(async () => {
        await _clearAllAttachments();
        process.env.PIZZAPI_MAX_ATTACHMENTS = "3";
    });

    afterEach(async () => {
        await _clearAllAttachments();
        if (originalMaxAttachments !== undefined) {
            process.env.PIZZAPI_MAX_ATTACHMENTS = originalMaxAttachments;
        } else {
            delete process.env.PIZZAPI_MAX_ATTACHMENTS;
        }
    });

    test("evicts oldest attachments when limit exceeded", async () => {
        for (let i = 0; i < 4; i++) {
            const file = new File(["content" + i], "file" + i + ".txt", { type: "text/plain" });
            await storeSessionAttachment({
                sessionId: "test-session",
                ownerUserId: "test-owner",
                uploaderUserId: "test-uploader",
                file,
            });
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(_getAttachmentCount()).toBe(3);
    });
});
