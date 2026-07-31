import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePackageIdentity } from "./identity.js";

describe("computePackageIdentity", () => {
    test("npm: strips version, keeps scope", () => {
        expect(computePackageIdentity("npm:@foo/bar@1.2.3").identity).toBe("npm:@foo/bar");
        expect(computePackageIdentity("npm:@foo/bar").identity).toBe("npm:@foo/bar");
        expect(computePackageIdentity("npm:pkg@1.0.0").identity).toBe("npm:pkg");
        expect(computePackageIdentity("npm:pkg").identity).toBe("npm:pkg");
    });

    test("git: normalizes all four documented source forms to the same identity", () => {
        const forms = [
            "git:github.com/user/repo@v1",
            "git:git@github.com:user/repo@v1",
            "https://github.com/user/repo@v1",
            "ssh://git@github.com/user/repo@v1",
        ];
        const identities = forms.map((f) => computePackageIdentity(f).identity);
        for (const id of identities) expect(id).toBe("git:github.com/user/repo");
    });

    test("local: resolves to canonical absolute path, symlinks included", () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-identity-")));
        try {
            const pkgDir = join(tmp, "pkg");
            mkdirSync(pkgDir);
            const id = computePackageIdentity(pkgDir, tmp);
            expect(id.kind).toBe("local");
            expect(id.identity).toBe(`local:${pkgDir}`);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("local: relative path resolves against baseDir", () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-identity-")));
        try {
            const pkgDir = join(tmp, "pkg");
            mkdirSync(pkgDir);
            const id = computePackageIdentity("./pkg", tmp);
            expect(id.identity).toBe(`local:${pkgDir}`);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
