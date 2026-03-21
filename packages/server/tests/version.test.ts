import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getBundledVersion, getHubVersionInfo } from "../src/version";

const ORIGINAL_IMAGE = process.env.PIZZAPI_HUB_IMAGE;
const ORIGINAL_VERSION = process.env.PIZZAPI_HUB_VERSION;
const SERVER_PACKAGE_PATH = join(import.meta.dirname ?? __dirname, "..", "package.json");
const SERVER_PACKAGE_VERSION: string | null = (() => {
    try {
        const pkg = JSON.parse(readFileSync(SERVER_PACKAGE_PATH, "utf-8")) as { version?: string };
        return pkg.version?.trim() || null;
    } catch {
        return null;
    }
})();

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

    test("returns the mutable tag as-is for image-mode deployments", () => {
        // Mutable tags like "latest" and "main" are returned verbatim, NOT
        // replaced with null.  Returning null would cause the /api/hub-info route
        // to substitute the latest npm version, which misrepresents the deployed
        // image (an operator who deployed :main would see "0.2.0" instead of
        // "main").
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi:latest";
        process.env.PIZZAPI_HUB_VERSION = "latest";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi:latest");
        expect(result.version).toBe("latest");
    });

    test("returns mutable tag for other mutable labels (main, stable, dev, nightly)", () => {
        for (const tag of ["main", "stable", "dev", "nightly"]) {
            process.env.PIZZAPI_HUB_IMAGE = `ghcr.io/acme/pizzapi:${tag}`;
            process.env.PIZZAPI_HUB_VERSION = tag;
            expect(getHubVersionInfo().version).toBe(tag);
        }
    });

    test("returns null version for source-build labels", () => {
        // "local" is the label resolveComposeMode() injects for source builds —
        // the npm registry fallback in /api/hub-info is appropriate here since
        // the running binary has a real release version we can surface.
        process.env.PIZZAPI_HUB_IMAGE = "local-build";
        process.env.PIZZAPI_HUB_VERSION = "local";

        expect(getHubVersionInfo().version).toBeNull();
    });

    test("derives the image tag when PIZZAPI_HUB_VERSION is unset", () => {
        delete process.env.PIZZAPI_HUB_VERSION;
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi:0.1.32";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi:0.1.32");
        // Missing version env var → derive the tag from the image so we don't
        // report the npm version for mutable deploys.
        expect(result.version).toBe("0.1.32");
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

    test("derives digest tag when version env var is unset", () => {
        delete process.env.PIZZAPI_HUB_VERSION;
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi@sha256:abcdef0123456789abcdef";

        expect(getHubVersionInfo()).toEqual({
            image: "ghcr.io/acme/pizzapi@sha256:abcdef0123456789abcdef",
            version: "sha256:abcdef012345",
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

    test("getBundledVersion returns the packaged server release", () => {
        if (SERVER_PACKAGE_VERSION === null) {
            expect(getBundledVersion()).toBeNull();
        } else {
            expect(getBundledVersion()).toBe(SERVER_PACKAGE_VERSION);
        }
    });
});
