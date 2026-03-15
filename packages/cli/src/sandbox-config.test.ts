/**
 * Tests for SandboxConfig schema, preset resolution, and merge semantics.
 *
 * Covers:
 *   - resolveSandboxConfig() preset expansion and path resolution
 *   - resolveSandboxConfig() user overrides merged on top of presets
 *   - mergeSandboxConfig() security invariants (deny=union, allow=intersection, mode escalation only)
 */
import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import { resolve } from "path";

import {
    resolveSandboxConfig,
    mergeSandboxConfig,
    type SandboxConfig,
    type ResolvedSandboxConfig,
    type PizzaPiConfig,
} from "./config";

const CWD = "/projects/app";
const HOME = homedir();

function cfg(sandbox?: SandboxConfig): PizzaPiConfig {
    return sandbox ? { sandbox } : {};
}

// ── resolveSandboxConfig — mode: none ─────────────────────────────────────────

describe("resolveSandboxConfig — none mode", () => {
    test("returns mode:none and srtConfig:null", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "none" }));
        expect(r.mode).toBe("none");
        expect(r.srtConfig).toBeNull();
    });

    test("overrides are ignored in none mode", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "none",
            filesystem: { allowWrite: ["/custom"] },
        }));
        expect(r.srtConfig).toBeNull();
    });
});

// ── resolveSandboxConfig — mode: basic ────────────────────────────────────────

describe("resolveSandboxConfig — basic mode (default)", () => {
    test("defaults to basic when no mode specified", () => {
        const r = resolveSandboxConfig(CWD, {});
        expect(r.mode).toBe("basic");
    });

    test("basic has no network key (no network sandboxing)", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "basic" }));
        expect(r.srtConfig).not.toBeNull();
        expect(r.srtConfig!.network).toBeUndefined();
    });

    test("basic denies sensitive dotfile reads", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "basic" }));
        const denyRead = r.srtConfig!.filesystem.denyRead;
        expect(denyRead).toContain(`${HOME}/.ssh`);
        expect(denyRead).toContain(`${HOME}/.aws`);
        expect(denyRead).toContain(`${HOME}/.gnupg`);
        expect(denyRead).toContain(`${HOME}/.config/gcloud`);
    });

    test("basic allows write to cwd and /tmp by default", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "basic" }));
        expect(r.srtConfig!.filesystem.allowWrite).toContain(CWD);
        expect(r.srtConfig!.filesystem.allowWrite).toContain("/tmp");
    });

    test("basic denies writes to .env files", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "basic" }));
        const denyWrite = r.srtConfig!.filesystem.denyWrite;
        expect(denyWrite.some(p => p.endsWith(".env"))).toBe(true);
        expect(denyWrite.some(p => p.endsWith(".env.local"))).toBe(true);
    });
});

// ── resolveSandboxConfig — mode: full ─────────────────────────────────────────

describe("resolveSandboxConfig — full mode", () => {
    test("full has network key with allowedDomains:[] (deny-all by default)", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "full" }));
        expect(r.srtConfig!.network).toBeDefined();
        expect(r.srtConfig!.network!.allowedDomains).toEqual([]);
        expect(r.srtConfig!.network!.deniedDomains).toEqual([]);
    });

    test("full allows local binding by default", () => {
        const r = resolveSandboxConfig(CWD, cfg({ mode: "full" }));
        expect(r.srtConfig!.network!.allowLocalBinding).toBe(true);
    });

    test("full has same filesystem protections as basic", () => {
        const basic = resolveSandboxConfig(CWD, cfg({ mode: "basic" }));
        const full = resolveSandboxConfig(CWD, cfg({ mode: "full" }));
        expect(full.srtConfig!.filesystem.denyRead).toEqual(basic.srtConfig!.filesystem.denyRead);
        expect(full.srtConfig!.filesystem.allowWrite).toEqual(basic.srtConfig!.filesystem.allowWrite);
        expect(full.srtConfig!.filesystem.denyWrite).toEqual(basic.srtConfig!.filesystem.denyWrite);
    });
});

// ── resolveSandboxConfig — path expansion ─────────────────────────────────────

describe("resolveSandboxConfig — path expansion", () => {
    test("expands ~ to homedir in denyRead", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { denyRead: ["~/.custom-secrets"] },
        }));
        expect(r.srtConfig!.filesystem.denyRead).toContain(`${HOME}/.custom-secrets`);
    });

    test("expands . to cwd in allowWrite", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { allowWrite: [".", "/tmp"] },
        }));
        expect(r.srtConfig!.filesystem.allowWrite).toContain(CWD);
        expect(r.srtConfig!.filesystem.allowWrite).toContain("/tmp");
    });

    test("resolves relative paths against cwd", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { allowWrite: ["subdir/output"] },
        }));
        expect(r.srtConfig!.filesystem.allowWrite).toContain(resolve(CWD, "subdir/output"));
    });
});

// ── resolveSandboxConfig — overrides ─────────────────────────────────────────

describe("resolveSandboxConfig — overrides", () => {
    test("filesystem.denyRead override is unioned with preset", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { denyRead: ["~/.extra-secrets"] },
        }));
        // Contains both preset and user-added paths
        expect(r.srtConfig!.filesystem.denyRead).toContain(`${HOME}/.ssh`);
        expect(r.srtConfig!.filesystem.denyRead).toContain(`${HOME}/.extra-secrets`);
    });

    test("filesystem.denyWrite override is unioned with preset", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { denyWrite: ["~/.bashrc"] },
        }));
        expect(r.srtConfig!.filesystem.denyWrite.some(p => p.endsWith(".env"))).toBe(true);
        expect(r.srtConfig!.filesystem.denyWrite).toContain(`${HOME}/.bashrc`);
    });

    test("filesystem.allowWrite override replaces preset", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            filesystem: { allowWrite: ["/custom/output"] },
        }));
        expect(r.srtConfig!.filesystem.allowWrite).toContain("/custom/output");
        // Preset CWD/tmp are gone (user replaced)
        expect(r.srtConfig!.filesystem.allowWrite).not.toContain(CWD);
    });

    test("network.allowedDomains override activates network sandboxing in basic mode", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            network: { allowedDomains: ["*.github.com"] },
        }));
        expect(r.srtConfig!.network).toBeDefined();
        expect(r.srtConfig!.network!.allowedDomains).toEqual(["*.github.com"]);
    });

    test("network.allowedDomains override replaces full-preset empty list", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "full",
            network: { allowedDomains: ["api.example.com", "*.github.com"] },
        }));
        expect(r.srtConfig!.network!.allowedDomains).toEqual(["api.example.com", "*.github.com"]);
    });

    test("network.deniedDomains override is unioned with preset in full mode", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "full",
            network: { deniedDomains: ["evil.example.com"] },
        }));
        expect(r.srtConfig!.network!.deniedDomains).toContain("evil.example.com");
    });

    test("pass-through options are forwarded", () => {
        const r = resolveSandboxConfig(CWD, cfg({
            mode: "basic",
            mandatoryDenySearchDepth: 5,
            allowPty: true,
            enableWeakerNetworkIsolation: true,
        }));
        expect(r.srtConfig!.mandatoryDenySearchDepth).toBe(5);
        expect(r.srtConfig!.allowPty).toBe(true);
        expect(r.srtConfig!.enableWeakerNetworkIsolation).toBe(true);
    });
});

// ── mergeSandboxConfig ────────────────────────────────────────────────────────

describe("mergeSandboxConfig — mode escalation", () => {
    test("project can escalate mode (basic → full)", () => {
        const merged = mergeSandboxConfig({ mode: "basic" }, { mode: "full" });
        expect(merged.mode).toBe("full");
    });

    test("project cannot weaken mode (full → basic)", () => {
        const merged = mergeSandboxConfig({ mode: "full" }, { mode: "basic" });
        expect(merged.mode).toBe("full");
    });

    test("project cannot weaken mode (full → none)", () => {
        const merged = mergeSandboxConfig({ mode: "full" }, { mode: "none" });
        expect(merged.mode).toBe("full");
    });

    test("project cannot weaken mode (basic → none)", () => {
        const merged = mergeSandboxConfig({ mode: "basic" }, { mode: "none" });
        expect(merged.mode).toBe("basic");
    });

    test("missing project mode inherits global", () => {
        const merged = mergeSandboxConfig({ mode: "full" }, {});
        expect(merged.mode).toBe("full");
    });

    test("missing global mode defaults to basic", () => {
        const merged = mergeSandboxConfig({}, { mode: "basic" });
        expect(merged.mode).toBe("basic");
    });
});

describe("mergeSandboxConfig — filesystem deny lists (union)", () => {
    test("denyRead is union of global + project", () => {
        const global: SandboxConfig = { filesystem: { denyRead: ["~/.ssh"] } };
        const project: SandboxConfig = { filesystem: { denyRead: ["~/.aws"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyRead).toContain("~/.ssh");
        expect(merged.filesystem?.denyRead).toContain("~/.aws");
    });

    test("denyWrite is union of global + project", () => {
        const global: SandboxConfig = { filesystem: { denyWrite: [".env"] } };
        const project: SandboxConfig = { filesystem: { denyWrite: [".env.local"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyWrite).toContain(".env");
        expect(merged.filesystem?.denyWrite).toContain(".env.local");
    });

    test("union deduplicates", () => {
        const global: SandboxConfig = { filesystem: { denyRead: ["~/.ssh"] } };
        const project: SandboxConfig = { filesystem: { denyRead: ["~/.ssh"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyRead?.filter(p => p === "~/.ssh")).toHaveLength(1);
    });
});

describe("mergeSandboxConfig — filesystem allowWrite (intersection)", () => {
    test("project can narrow allowWrite", () => {
        const global: SandboxConfig = { filesystem: { allowWrite: [".", "/tmp", "/extra"] } };
        const project: SandboxConfig = { filesystem: { allowWrite: [".", "/tmp"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowWrite).toContain(".");
        expect(merged.filesystem?.allowWrite).toContain("/tmp");
        expect(merged.filesystem?.allowWrite).not.toContain("/extra");
    });

    test("project cannot widen allowWrite", () => {
        const global: SandboxConfig = { filesystem: { allowWrite: ["."] } };
        const project: SandboxConfig = { filesystem: { allowWrite: [".", "/extra"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowWrite).toContain(".");
        expect(merged.filesystem?.allowWrite).not.toContain("/extra");
    });

    test("unspecified global allowWrite ignores project (uses preset default)", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { filesystem: { allowWrite: [".", "/sneaky"] } };
        const merged = mergeSandboxConfig(global, project);
        // When global doesn't specify allowWrite, project cannot introduce
        // arbitrary values — undefined is returned so the preset default is used.
        expect(merged.filesystem?.allowWrite).toBeUndefined();
    });

    test("project cannot widen allowWrite when global is omitted", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { filesystem: { allowWrite: ["/", "/etc", "/var"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowWrite).toBeUndefined();
    });
});

describe("mergeSandboxConfig — network", () => {
    test("allowedDomains intersection: project can only narrow", () => {
        const global: SandboxConfig = { network: { allowedDomains: ["a.com", "b.com"] } };
        const project: SandboxConfig = { network: { allowedDomains: ["a.com", "c.com"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.allowedDomains).toEqual(["a.com"]);
    });

    test("project cannot widen allowedDomains when global is omitted", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { network: { allowedDomains: ["evil.com"] } };
        const merged = mergeSandboxConfig(global, project);
        // When global doesn't specify allowedDomains, project cannot introduce
        // arbitrary domains — undefined is returned so the preset default is used.
        expect(merged.network?.allowedDomains).toBeUndefined();
    });

    test("deniedDomains union: project can add more denials", () => {
        const global: SandboxConfig = { network: { deniedDomains: ["bad.com"] } };
        const project: SandboxConfig = { network: { deniedDomains: ["evil.com"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.deniedDomains).toContain("bad.com");
        expect(merged.network?.deniedDomains).toContain("evil.com");
    });

    test("global allowLocalBinding wins", () => {
        const global: SandboxConfig = { network: { allowLocalBinding: false } };
        const project: SandboxConfig = { network: { allowLocalBinding: true } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.allowLocalBinding).toBe(false);
    });

    test("project allowLocalBinding cannot weaken when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { network: { allowLocalBinding: true } };
        const merged = mergeSandboxConfig(global, project);
        // keepStrict: project cannot enable weakening when global is absent
        expect(merged.network?.allowLocalBinding).toBeUndefined();
    });

    test("project allowLocalBinding=false preserved when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { network: { allowLocalBinding: false } };
        const merged = mergeSandboxConfig(global, project);
        // keepStrict: project can maintain strict (false) settings
        expect(merged.network?.allowLocalBinding).toBe(false);
    });
});

describe("mergeSandboxConfig — scalar fields propagated", () => {
    test("allowUnixSockets: intersect — project cannot widen socket allowlist", () => {
        const global: SandboxConfig = { network: { allowUnixSockets: ["/run/g.sock", "/run/shared.sock"] } };
        const project: SandboxConfig = { network: { allowUnixSockets: ["/run/p.sock", "/run/shared.sock"] } };
        const merged = mergeSandboxConfig(global, project);
        // Only the intersection is kept — project cannot add new sockets
        expect(merged.network?.allowUnixSockets).toEqual(["/run/shared.sock"]);
        expect(merged.network?.allowUnixSockets).not.toContain("/run/p.sock");
    });

    test("allowUnixSockets: no overlap yields empty array", () => {
        const global: SandboxConfig = { network: { allowUnixSockets: ["/run/g.sock"] } };
        const project: SandboxConfig = { network: { allowUnixSockets: ["/run/p.sock"] } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.allowUnixSockets).toEqual([]);
    });

    test("allowUnixSockets: project cannot introduce sockets when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { network: { allowUnixSockets: ["/run/p.sock"] } };
        const merged = mergeSandboxConfig(global, project);
        // intersect: global undefined → return undefined (preserve preset default)
        expect(merged.network?.allowUnixSockets).toBeUndefined();
    });

    test("allowAllUnixSockets: global wins", () => {
        const global: SandboxConfig = { network: { allowAllUnixSockets: false } };
        const project: SandboxConfig = { network: { allowAllUnixSockets: true } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.allowAllUnixSockets).toBe(false);
    });

    test("httpProxyPort: global wins", () => {
        const global: SandboxConfig = { network: { httpProxyPort: 8080 } };
        const project: SandboxConfig = { network: { httpProxyPort: 9090 } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.httpProxyPort).toBe(8080);
    });

    test("socksProxyPort: project used when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { network: { socksProxyPort: 1080 } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.network?.socksProxyPort).toBe(1080);
    });

    test("allowGitConfig: global wins", () => {
        const global: SandboxConfig = { filesystem: { allowGitConfig: false } };
        const project: SandboxConfig = { filesystem: { allowGitConfig: true } };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowGitConfig).toBe(false);
    });

    test("allowGitConfig: strict default kept when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { filesystem: { allowGitConfig: true } };
        const merged = mergeSandboxConfig(global, project);
        // Security invariant: project cannot enable allowGitConfig when global config absent
        expect(merged.filesystem?.allowGitConfig).toBeUndefined();
    });

    test("allowPty: global wins", () => {
        const global: SandboxConfig = { allowPty: false };
        const project: SandboxConfig = { allowPty: true };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.allowPty).toBe(false);
    });

    test("enableWeakerNetworkIsolation: strict default kept when global not set", () => {
        const global: SandboxConfig = {};
        const project: SandboxConfig = { enableWeakerNetworkIsolation: true };
        const merged = mergeSandboxConfig(global, project);
        // Security invariant: project cannot enable weaker isolation when global config absent
        expect(merged.enableWeakerNetworkIsolation).toBeUndefined();
    });

    test("mandatoryDenySearchDepth: global wins", () => {
        const global: SandboxConfig = { mandatoryDenySearchDepth: 2 };
        const project: SandboxConfig = { mandatoryDenySearchDepth: 5 };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.mandatoryDenySearchDepth).toBe(2);
    });
});
