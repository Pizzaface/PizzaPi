import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computePackageIdentity, packageScopeBaseDir } from "./identity.js";

const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
    // The upstream comparator reads HOME at call time while our resolver uses
    // os.homedir()'s startup value. Keep both sides on the same home directory.
    process.env.HOME = homedir();
    delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

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

    test("git: preserves path case, normalizes host case only", () => {
        expect(computePackageIdentity("git:GitHub.com/User/Repo").identity).toBe("git:github.com/User/Repo");
        expect(computePackageIdentity("https://GitHub.COM/User/Repo").identity).toBe("git:github.com/User/Repo");
    });

    test("git: handles ssh port (port is dropped from identity, same as host)", () => {
        expect(computePackageIdentity("ssh://git@github.com:2222/user/repo@v1").identity).toBe(
            "git:github.com/user/repo",
        );
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

    test("local: expands a leading ~ against the home directory", () => {
        // Use the real home directory (no filesystem writes needed — realpath
        // falls back to the resolved path when the target doesn't exist).
        const id = computePackageIdentity("~/pizzapi-identity-tilde-fixture-does-not-exist");
        expect(id.identity).toBe(`local:${join(homedir(), "pizzapi-identity-tilde-fixture-does-not-exist")}`);
    });
});

describe("packageScopeBaseDir", () => {
    test("user scope uses the agent dir; project scope uses <cwd>/.pizzapi", () => {
        expect(packageScopeBaseDir("user", "/cwd", "/agent")).toBe("/agent");
        expect(packageScopeBaseDir("project", "/cwd", "/agent")).toBe(join("/cwd", ".pizzapi"));
    });
});

/**
 * Characterization tests pinning computePackageIdentity() against pi
 * 0.82.1's own (private, test-only-cast) DefaultPackageManager.getPackageIdentity()
 * for every documented source form plus tilde/case/port and both scopes.
 * `getPackageIdentity` is intentionally not used in production code (it's
 * private/unexported); this cast exists only so tests can assert parity.
 */
describe("computePackageIdentity matches upstream getPackageIdentity()", () => {
    function makePm(cwd: string, agentDir: string): { getPackageIdentity(source: string, scope?: "user" | "project"): string } {
        const settingsManager = SettingsManager.create(cwd, agentDir);
        return new DefaultPackageManager({ cwd, agentDir, settingsManager }) as unknown as {
            getPackageIdentity(source: string, scope?: "user" | "project"): string;
        };
    }

    const gitForms = [
        "git:github.com/user/repo@v1",
        "git:git@github.com:user/repo@v1",
        "https://github.com/user/repo@v1",
        "ssh://git@github.com/user/repo@v1",
        "git:GitHub.com/User/Repo",
        "ssh://git@github.com:2222/user/repo@v1",
        "npm:@foo/bar@1.2.3",
        "npm:pkg",
    ];

    test("git/npm forms match upstream regardless of scope", () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-identity-parity-")));
        try {
            const agentDir = join(tmp, "agent");
            const cwd = join(tmp, "project");
            mkdirSync(agentDir, { recursive: true });
            mkdirSync(cwd, { recursive: true });
            const pm = makePm(cwd, agentDir);
            for (const scope of ["user", "project"] as const) {
                for (const source of gitForms) {
                    expect(computePackageIdentity(source).identity).toBe(pm.getPackageIdentity(source, scope));
                }
            }
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("local paths match upstream per-scope base dir resolution (cwd and agentDir at different depths)", () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-identity-parity-")));
        try {
            // agentDir and cwd deliberately at different nesting depths.
            const agentDir = join(tmp, "deep", "nested", "agent");
            const cwd = join(tmp, "project");
            mkdirSync(agentDir, { recursive: true });
            mkdirSync(cwd, { recursive: true });
            const pm = makePm(cwd, agentDir);

            for (const scope of ["user", "project"] as const) {
                const baseDir = packageScopeBaseDir(scope, cwd, agentDir);
                for (const rel of ["./pkg", "~/pizzapi-identity-tilde-fixture-does-not-exist"]) {
                    const ours = computePackageIdentity(rel, baseDir).identity;
                    const upstream = pm.getPackageIdentity(rel, scope);
                    expect(ours).toBe(upstream);
                }
            }
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
