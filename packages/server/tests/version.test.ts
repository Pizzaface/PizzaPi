import { afterEach, describe, expect, test } from "bun:test";
import { getHubVersionInfo } from "../src/version";

const ORIGINAL_IMAGE = process.env.PIZZAPI_HUB_IMAGE;
const ORIGINAL_VERSION = process.env.PIZZAPI_HUB_VERSION;

afterEach(() => {
    if (ORIGINAL_IMAGE === undefined) {
        delete process.env.PIZZAPI_HUB_IMAGE;
    } else {
        process.env.PIZZAPI_HUB_IMAGE = ORIGINAL_IMAGE;
    }

    if (ORIGINAL_VERSION === undefined) {
        delete process.env.PIZZAPI_HUB_VERSION;
    } else {
        process.env.PIZZAPI_HUB_VERSION = ORIGINAL_VERSION;
    }
});

describe("getHubVersionInfo", () => {
    test("returns null for both image and version when env vars are unset", () => {
        delete process.env.PIZZAPI_HUB_IMAGE;
        delete process.env.PIZZAPI_HUB_VERSION;

        const result = getHubVersionInfo();
        expect(result.image).toBeNull();
        // Version is null — no vague label or missing env var should surface as
        // a real version.  Callers (e.g. /api/hub-info) fall back to
        // getLatestNpmVersion() to avoid reporting a stale package.json value.
        expect(result.version).toBeNull();
    });

    test("returns null version for vague labels like 'latest'", () => {
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi:latest";
        process.env.PIZZAPI_HUB_VERSION = "latest";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi:latest");
        expect(result.version).toBeNull();
    });

    test("returns null version for source-build vague labels", () => {
        process.env.PIZZAPI_HUB_IMAGE = "local-build";
        process.env.PIZZAPI_HUB_VERSION = "local";

        expect(getHubVersionInfo().version).toBeNull();
    });

    test("returns null version when PIZZAPI_HUB_VERSION is unset (image present)", () => {
        delete process.env.PIZZAPI_HUB_VERSION;
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi:0.1.32";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi:0.1.32");
        // Missing version env var → null; route will substitute npm version.
        expect(result.version).toBeNull();
    });

    test("returns pinned semver version when PIZZAPI_HUB_VERSION is a specific tag", () => {
        process.env.PIZZAPI_HUB_IMAGE = " ghcr.io/acme/pizzapi:0.1.32 ";
        process.env.PIZZAPI_HUB_VERSION = " 0.1.32 ";

        expect(getHubVersionInfo()).toEqual({
            image: "ghcr.io/acme/pizzapi:0.1.32",
            version: "0.1.32",
        });
    });

    test("returns null image when only PIZZAPI_HUB_IMAGE is unset", () => {
        delete process.env.PIZZAPI_HUB_IMAGE;
        process.env.PIZZAPI_HUB_VERSION = "0.1.32";

        expect(getHubVersionInfo()).toEqual({
            image: null,
            version: "0.1.32",
        });
    });

    test("returns digest-abbreviated version as a pinned (non-vague) value", () => {
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi@sha256:abc123";
        process.env.PIZZAPI_HUB_VERSION = "sha256-abc";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi@sha256:abc123");
        // Short digest abbreviations are pinned — they are not in VAGUE_VERSIONS.
        expect(result.version).toBe("sha256-abc");
    });
});
