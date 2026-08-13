import { describe, expect, test } from "bun:test";
import { deferReloadUntilBackground, isSecureOtaOrigin, shouldApplyOta } from "./mobile-ota";

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

    test("kill-switch: rejects a bundle older than minBuildTimestamp", () => {
        // The offered bundle is newer than what's installed, but ops set a
        // floor above its own buildTimestamp to strand it.
        expect(shouldApplyOta({ ...valid, minBuildTimestamp: "2027-01-01T00:00:00.000Z" }, installed)).toBe(false);
    });

    test("kill-switch: applies a bundle at or above minBuildTimestamp", () => {
        expect(shouldApplyOta({ ...valid, minBuildTimestamp: valid.buildTimestamp }, installed)).toBe(true);
        expect(shouldApplyOta({ ...valid, minBuildTimestamp: "2020-01-01T00:00:00.000Z" }, installed)).toBe(true);
    });

    test("absent minBuildTimestamp still applies (backward compatible)", () => {
        expect("minBuildTimestamp" in valid).toBe(false);
        expect(shouldApplyOta(valid, installed)).toBe(true);
    });
});

describe("isSecureOtaOrigin", () => {
    test("allows https origins", () => {
        expect(isSecureOtaOrigin("https://relay.example.com")).toBe(true);
        expect(isSecureOtaOrigin("HTTPS://relay.example.com/")).toBe(true);
        expect(isSecureOtaOrigin("  https://relay.example.com  ")).toBe(true);
    });

    test("rejects http (incl. LAN/loopback) and other schemes", () => {
        expect(isSecureOtaOrigin("http://192.168.1.5:8080")).toBe(false);
        expect(isSecureOtaOrigin("http://localhost:3000")).toBe(false);
        expect(isSecureOtaOrigin("http://relay.local")).toBe(false);
        expect(isSecureOtaOrigin("ftp://x")).toBe(false);
        expect(isSecureOtaOrigin("")).toBe(false);
        // Guard against sneaky prefixes that merely contain "https".
        expect(isSecureOtaOrigin("httpshh://x")).toBe(false);
        expect(isSecureOtaOrigin("http://x?https://y")).toBe(false);
    });
});

describe("deferReloadUntilBackground", () => {
    test("does not reload immediately after registering", async () => {
        let reloadCalls = 0;
        const appPlugin = {
            addListener: async () => ({ remove: async () => {} }),
        };
        const updater = { reload: async () => { reloadCalls++; } };

        deferReloadUntilBackground(appPlugin, updater);
        // Let the (fake) addListener promise settle.
        await Promise.resolve();
        await Promise.resolve();

        expect(reloadCalls).toBe(0);
    });

    test("reloads only once the app backgrounds, not while foregrounded", async () => {
        let listener: ((state: { isActive: boolean }) => void) | undefined;
        let reloadCalls = 0;
        const appPlugin = {
            addListener: async (_event: "appStateChange", cb: (state: { isActive: boolean }) => void) => {
                listener = cb;
                return { remove: async () => {} };
            },
        };
        const updater = { reload: async () => { reloadCalls++; } };

        deferReloadUntilBackground(appPlugin, updater);
        await Promise.resolve();
        await Promise.resolve();
        expect(listener).toBeDefined();

        listener!({ isActive: true }); // still foregrounded — must not reload
        expect(reloadCalls).toBe(0);

        listener!({ isActive: false }); // backgrounded — now it's safe to reload
        expect(reloadCalls).toBe(1);
    });
});
