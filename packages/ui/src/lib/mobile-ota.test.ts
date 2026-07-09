import { describe, expect, test } from "bun:test";
import { shouldApplyOta } from "./mobile-ota";

const installed = "2026-07-09T10:00:00.000Z";
const valid = {
    buildTimestamp: "2026-07-09T12:00:00.000Z",
    version: "2026-07-09T12:00:00.000Z",
    url: "/api/mobile/ota/pizzapi-x.zip",
    checksum: "abc123",
};

describe("shouldApplyOta", () => {
    test("applies when the manifest is strictly newer", () => {
        expect(shouldApplyOta(valid, installed)).toBe(true);
    });

    test("skips when same or older (ISO strings sort lexically)", () => {
        expect(shouldApplyOta({ ...valid, buildTimestamp: installed }, installed)).toBe(false);
        expect(shouldApplyOta({ ...valid, buildTimestamp: "2026-07-09T09:00:00.000Z" }, installed)).toBe(false);
    });

    test("rejects manifests missing url or checksum", () => {
        expect(shouldApplyOta({ ...valid, url: "" }, installed)).toBe(false);
        expect(shouldApplyOta({ ...valid, checksum: "" }, installed)).toBe(false);
        const { checksum: _c, ...noChecksum } = valid;
        expect(shouldApplyOta(noChecksum, installed)).toBe(false);
    });

    test("rejects non-object / junk payloads", () => {
        expect(shouldApplyOta(null, installed)).toBe(false);
        expect(shouldApplyOta("nope", installed)).toBe(false);
        expect(shouldApplyOta({}, installed)).toBe(false);
    });

    test("applies against an empty installed timestamp (fresh install / dev)", () => {
        expect(shouldApplyOta(valid, "")).toBe(true);
    });
});
