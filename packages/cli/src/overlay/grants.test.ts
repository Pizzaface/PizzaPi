import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config/io.js";
import {
    getOverlayServiceGrants,
    getGrantedServiceIds,
    grantServices,
    revokeServices,
    pruneOrphanGrants,
    resolveServiceGrantState,
} from "./grants.js";

describe("overlay grants", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-grants-"));
        _setGlobalConfigDir(dir);
    });

    afterEach(() => {
        _setGlobalConfigDir(null);
        rmSync(dir, { recursive: true, force: true });
    });

    test("grant is exact — only listed service ids are granted", () => {
        grantServices("npm:@acme/pkg", ["github", "gitlab"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github", "gitlab"]));
        expect(getGrantedServiceIds("npm:@acme/pkg").has("bitbucket")).toBe(false);
    });

    test("granting again unions rather than replacing", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        grantServices("npm:@acme/pkg", ["gitlab"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github", "gitlab"]));
    });

    test("added service ids after an update remain untrusted (no grant call = no grant)", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        // Simulates a package update that adds a new declared id "gitlab" —
        // nothing calls grantServices for it, so it must stay ungranted.
        expect(getGrantedServiceIds("npm:@acme/pkg").has("gitlab")).toBe(false);
    });

    test("revoke removes only the listed ids, and clears the entry when empty", () => {
        grantServices("npm:@acme/pkg", ["github", "gitlab"]);
        revokeServices("npm:@acme/pkg", ["github"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["gitlab"]));

        revokeServices("npm:@acme/pkg", ["gitlab"]);
        expect(getOverlayServiceGrants()).toHaveLength(0);
    });

    test("pruneOrphanGrants removes grants whose identity is no longer configured", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        grantServices("local:/old/path", ["svc"]);

        const removed = pruneOrphanGrants(new Set(["npm:@acme/pkg"]));
        expect(removed).toHaveLength(1);
        expect(removed[0]?.package).toBe("local:/old/path");
        expect(getGrantedServiceIds("local:/old/path").size).toBe(0);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github"]));
    });

    test("resolveServiceGrantState: untrusted -> granted -> disabled", () => {
        expect(resolveServiceGrantState("npm:@acme/pkg", "github")).toBe("untrusted");
        grantServices("npm:@acme/pkg", ["github"]);
        expect(resolveServiceGrantState("npm:@acme/pkg", "github")).toBe("granted");
        expect(resolveServiceGrantState("npm:@acme/pkg", "github", ["github"])).toBe("disabled");
    });
});
