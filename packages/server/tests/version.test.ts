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
    test("returns nulls when env vars are unset", () => {
        delete process.env.PIZZAPI_HUB_IMAGE;
        delete process.env.PIZZAPI_HUB_VERSION;

        expect(getHubVersionInfo()).toEqual({ image: null, version: null });
    });

    test("returns trimmed env var values", () => {
        process.env.PIZZAPI_HUB_IMAGE = " ghcr.io/acme/pizzapi:0.1.32 ";
        process.env.PIZZAPI_HUB_VERSION = " 0.1.32 ";

        expect(getHubVersionInfo()).toEqual({
            image: "ghcr.io/acme/pizzapi:0.1.32",
            version: "0.1.32",
        });
    });
});
