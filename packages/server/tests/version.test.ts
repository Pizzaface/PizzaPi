import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
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

/**
 * Read the server package.json version — mirrors the fallback logic in the
 * version module.  We use the server package because the CLI package is not
 * present inside the Docker production image; see packages/server/src/version.ts.
 */
function localPackageVersion(): string | null {
    try {
        const pkgPath = join(import.meta.dirname ?? __dirname, "../package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
        return pkg.version?.trim() || null;
    } catch {
        return null;
    }
}

describe("getHubVersionInfo", () => {
    test("returns null image but falls back to package version when env vars are unset", () => {
        delete process.env.PIZZAPI_HUB_IMAGE;
        delete process.env.PIZZAPI_HUB_VERSION;

        const result = getHubVersionInfo();
        expect(result.image).toBeNull();
        // version should fall back to the package.json version, not null
        expect(result.version).toBe(localPackageVersion());
        expect(result.version).not.toBeNull();
    });

    test("returns trimmed env var values when both are set", () => {
        process.env.PIZZAPI_HUB_IMAGE = " ghcr.io/acme/pizzapi:0.1.32 ";
        process.env.PIZZAPI_HUB_VERSION = " 0.1.32 ";

        expect(getHubVersionInfo()).toEqual({
            image: "ghcr.io/acme/pizzapi:0.1.32",
            version: "0.1.32",
        });
    });

    test("falls back to package version when only PIZZAPI_HUB_VERSION is unset", () => {
        delete process.env.PIZZAPI_HUB_VERSION;
        process.env.PIZZAPI_HUB_IMAGE = "ghcr.io/acme/pizzapi:0.1.32";

        const result = getHubVersionInfo();
        expect(result.image).toBe("ghcr.io/acme/pizzapi:0.1.32");
        expect(result.version).toBe(localPackageVersion());
    });

    test("returns null image when only PIZZAPI_HUB_IMAGE is unset", () => {
        delete process.env.PIZZAPI_HUB_IMAGE;
        process.env.PIZZAPI_HUB_VERSION = "0.1.32";

        expect(getHubVersionInfo()).toEqual({
            image: null,
            version: "0.1.32",
        });
    });
});
