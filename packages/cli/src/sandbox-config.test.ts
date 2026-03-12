/**
 * Tests for SandboxConfig schema, defaults, resolution, and merge semantics.
 *
 * Covers:
 *   - DEFAULT_SANDBOX_CONFIG correctness
 *   - resolveSandboxConfig() path expansion (~ and .)
 *   - mergeSandboxConfig() security invariants (deny=union, allow=intersection)
 */
import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import { resolve } from "path";

import {
    DEFAULT_SANDBOX_CONFIG,
    resolveSandboxConfig,
    mergeSandboxConfig,
    type SandboxConfig,
    type ResolvedSandboxConfig,
    type PizzaPiConfig,
} from "./config";

// ── DEFAULT_SANDBOX_CONFIG ────────────────────────────────────────────────────

describe("DEFAULT_SANDBOX_CONFIG", () => {
    test("has sandbox enabled in enforce mode", () => {
        expect(DEFAULT_SANDBOX_CONFIG.enabled).toBe(true);
        expect(DEFAULT_SANDBOX_CONFIG.mode).toBe("enforce");
    });

    test("uses denylist network mode with empty domain lists", () => {
        expect(DEFAULT_SANDBOX_CONFIG.network.mode).toBe("denylist");
        expect(DEFAULT_SANDBOX_CONFIG.network.allowedDomains).toEqual([]);
        expect(DEFAULT_SANDBOX_CONFIG.network.deniedDomains).toEqual([]);
    });

    test("denies reading sensitive dotfile directories", () => {
        const dr = DEFAULT_SANDBOX_CONFIG.filesystem.denyRead;
        expect(dr).toContain("~/.ssh");
        expect(dr).toContain("~/.aws");
        expect(dr).toContain("~/.gnupg");
        expect(dr).toContain("~/.config/gcloud");
        expect(dr).toContain("~/.docker/config.json");
    });

    test("allows writing to cwd and /tmp by default", () => {
        expect(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite).toContain(".");
        expect(DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite).toContain("/tmp");
    });

    test("denies writing to .env files and ~/.ssh", () => {
        const dw = DEFAULT_SANDBOX_CONFIG.filesystem.denyWrite;
        expect(dw).toContain(".env");
        expect(dw).toContain(".env.local");
        expect(dw).toContain("~/.ssh");
    });

    test("denies docker socket access", () => {
        expect(DEFAULT_SANDBOX_CONFIG.sockets.deny).toContain("/var/run/docker.sock");
    });

    test("MCP defaults to empty allowed domains and /tmp write", () => {
        expect(DEFAULT_SANDBOX_CONFIG.mcp.allowedDomains).toEqual([]);
        expect(DEFAULT_SANDBOX_CONFIG.mcp.allowWrite).toEqual(["/tmp"]);
    });
});

// ── resolveSandboxConfig ──────────────────────────────────────────────────────

describe("resolveSandboxConfig", () => {
    const cwd = "/projects/my-app";
    const home = homedir();

    test("returns defaults when no sandbox config is provided", () => {
        const resolved = resolveSandboxConfig(cwd, {});
        expect(resolved.enabled).toBe(true);
        expect(resolved.mode).toBe("enforce");
        expect(resolved.network.mode).toBe("denylist");
    });

    test("expands ~ to homedir in filesystem.denyRead", () => {
        const resolved = resolveSandboxConfig(cwd, {});
        // Default denyRead includes ~/.ssh → should expand
        expect(resolved.filesystem.denyRead).toContain(`${home}/.ssh`);
        expect(resolved.filesystem.denyRead).toContain(`${home}/.aws`);
        expect(resolved.filesystem.denyRead).toContain(`${home}/.gnupg`);
    });

    test("expands ~ to homedir in filesystem.denyWrite", () => {
        const resolved = resolveSandboxConfig(cwd, {});
        expect(resolved.filesystem.denyWrite).toContain(`${home}/.ssh`);
    });

    test("resolves . to cwd in filesystem.allowWrite", () => {
        const resolved = resolveSandboxConfig(cwd, {});
        expect(resolved.filesystem.allowWrite).toContain(resolve(cwd));
        expect(resolved.filesystem.allowWrite).toContain("/tmp");
    });

    test("expands ~ in user-provided paths", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                filesystem: {
                    denyRead: ["~/.kube", "~/.terraform"],
                },
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.filesystem.denyRead).toContain(`${home}/.kube`);
        expect(resolved.filesystem.denyRead).toContain(`${home}/.terraform`);
    });

    test("resolves relative paths against cwd", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                filesystem: {
                    denyRead: ["secrets/keys"],
                },
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.filesystem.denyRead).toContain(resolve(cwd, "secrets/keys"));
    });

    test("preserves absolute paths unchanged", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                filesystem: {
                    denyRead: ["/etc/shadow"],
                },
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.filesystem.denyRead).toContain("/etc/shadow");
    });

    test("user-provided scalars override defaults", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                enabled: false,
                mode: "audit",
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.enabled).toBe(false);
        expect(resolved.mode).toBe("audit");
    });

    test("user-provided network config overrides defaults", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                network: {
                    mode: "allowlist",
                    allowedDomains: ["api.example.com"],
                },
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.network.mode).toBe("allowlist");
        expect(resolved.network.allowedDomains).toEqual(["api.example.com"]);
        // deniedDomains defaults to empty when not specified
        expect(resolved.network.deniedDomains).toEqual([]);
    });

    test("resolves mcp.allowWrite paths", () => {
        const config: PizzaPiConfig = {
            sandbox: {
                mcp: {
                    allowWrite: [".", "/tmp/mcp"],
                },
            },
        };
        const resolved = resolveSandboxConfig(cwd, config);
        expect(resolved.mcp.allowWrite).toContain(resolve(cwd));
        expect(resolved.mcp.allowWrite).toContain("/tmp/mcp");
    });
});

// ── mergeSandboxConfig ────────────────────────────────────────────────────────

describe("mergeSandboxConfig", () => {
    test("unions denyRead lists (project can add, not remove)", () => {
        const global: SandboxConfig = {
            filesystem: { denyRead: ["~/.ssh", "~/.aws"] },
        };
        const project: SandboxConfig = {
            filesystem: { denyRead: ["~/.kube", "~/.ssh"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyRead).toContain("~/.ssh");
        expect(merged.filesystem?.denyRead).toContain("~/.aws");
        expect(merged.filesystem?.denyRead).toContain("~/.kube");
        // No duplicates
        expect(merged.filesystem?.denyRead?.filter((x) => x === "~/.ssh")).toHaveLength(1);
    });

    test("unions denyWrite lists", () => {
        const global: SandboxConfig = {
            filesystem: { denyWrite: [".env", "~/.ssh"] },
        };
        const project: SandboxConfig = {
            filesystem: { denyWrite: [".env.production"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyWrite).toContain(".env");
        expect(merged.filesystem?.denyWrite).toContain("~/.ssh");
        expect(merged.filesystem?.denyWrite).toContain(".env.production");
    });

    test("intersects allowWrite lists (project can only narrow)", () => {
        const global: SandboxConfig = {
            filesystem: { allowWrite: [".", "/tmp", "/var/data"] },
        };
        const project: SandboxConfig = {
            filesystem: { allowWrite: [".", "/tmp"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowWrite).toContain(".");
        expect(merged.filesystem?.allowWrite).toContain("/tmp");
        expect(merged.filesystem?.allowWrite).not.toContain("/var/data");
    });

    test("project cannot add new entries to allowWrite", () => {
        const global: SandboxConfig = {
            filesystem: { allowWrite: [".", "/tmp"] },
        };
        const project: SandboxConfig = {
            filesystem: { allowWrite: [".", "/tmp", "/etc"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.allowWrite).toContain(".");
        expect(merged.filesystem?.allowWrite).toContain("/tmp");
        expect(merged.filesystem?.allowWrite).not.toContain("/etc");
    });

    test("project cannot remove global denyRead entries", () => {
        const global: SandboxConfig = {
            filesystem: { denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"] },
        };
        // Project tries to specify only a subset — but union means global entries persist
        const project: SandboxConfig = {
            filesystem: { denyRead: ["~/.kube"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.filesystem?.denyRead).toContain("~/.ssh");
        expect(merged.filesystem?.denyRead).toContain("~/.aws");
        expect(merged.filesystem?.denyRead).toContain("~/.gnupg");
        expect(merged.filesystem?.denyRead).toContain("~/.kube");
    });

    test("unions sockets.deny lists", () => {
        const global: SandboxConfig = {
            sockets: { deny: ["/var/run/docker.sock"] },
        };
        const project: SandboxConfig = {
            sockets: { deny: ["/var/run/containerd.sock"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.sockets?.deny).toContain("/var/run/docker.sock");
        expect(merged.sockets?.deny).toContain("/var/run/containerd.sock");
    });

    test("intersects mcp.allowedDomains", () => {
        const global: SandboxConfig = {
            mcp: { allowedDomains: ["api.example.com", "cdn.example.com"] },
        };
        const project: SandboxConfig = {
            mcp: { allowedDomains: ["api.example.com"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.mcp?.allowedDomains).toContain("api.example.com");
        expect(merged.mcp?.allowedDomains).not.toContain("cdn.example.com");
    });

    test("intersects mcp.allowWrite", () => {
        const global: SandboxConfig = {
            mcp: { allowWrite: ["/tmp", "/var/mcp"] },
        };
        const project: SandboxConfig = {
            mcp: { allowWrite: ["/tmp"] },
        };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.mcp?.allowWrite).toContain("/tmp");
        expect(merged.mcp?.allowWrite).not.toContain("/var/mcp");
    });

    test("project cannot weaken enabled (global enabled stays enabled)", () => {
        const global: SandboxConfig = { enabled: true };
        const project: SandboxConfig = { enabled: false };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.enabled).toBe(true);
    });

    test("project cannot weaken mode (enforce > audit > off)", () => {
        const global: SandboxConfig = { mode: "enforce" };
        const project: SandboxConfig = { mode: "audit" };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.mode).toBe("enforce");
    });

    test("project can strengthen mode (audit → enforce)", () => {
        const global: SandboxConfig = { mode: "audit" };
        const project: SandboxConfig = { mode: "enforce" };
        const merged = mergeSandboxConfig(global, project);
        expect(merged.mode).toBe("enforce");
    });

    test("empty project config leaves global unchanged", () => {
        const global: SandboxConfig = {
            enabled: true,
            mode: "enforce",
            filesystem: {
                denyRead: ["~/.ssh"],
                allowWrite: [".", "/tmp"],
                denyWrite: [".env"],
            },
            sockets: { deny: ["/var/run/docker.sock"] },
        };
        const merged = mergeSandboxConfig(global, {});
        expect(merged.enabled).toBe(true);
        expect(merged.mode).toBe("enforce");
        expect(merged.filesystem?.denyRead).toEqual(["~/.ssh"]);
        expect(merged.filesystem?.allowWrite).toEqual([".", "/tmp"]);
        expect(merged.filesystem?.denyWrite).toEqual([".env"]);
        expect(merged.sockets?.deny).toEqual(["/var/run/docker.sock"]);
    });

    test("both empty configs produce undefined arrays", () => {
        const merged = mergeSandboxConfig({}, {});
        // Scalars get defaults
        expect(merged.enabled).toBe(true);
        expect(merged.mode).toBe("enforce");
    });
});

// ── Environment variable override patterns ────────────────────────────────────
//
// These test the patterns used by worker.ts and index.ts to apply env overrides
// on top of a resolved config. We test the logic, not the process lifecycle.

describe("environment variable override patterns", () => {
    /**
     * Simulates the env override logic from worker.ts / index.ts.
     * This tests the code pattern without actually launching a worker.
     */
    function applyEnvOverrides(
        config: ResolvedSandboxConfig,
        env: Record<string, string | undefined>,
    ): ResolvedSandboxConfig {
        const result = { ...config, network: { ...config.network } };

        // PIZZAPI_NO_SANDBOX=1 → mode off
        if (env.PIZZAPI_NO_SANDBOX === "1") {
            result.mode = "off";
        }

        // PIZZAPI_SANDBOX overrides mode
        const sandboxMode = env.PIZZAPI_SANDBOX;
        if (sandboxMode === "off") {
            result.mode = "off";
        } else if (sandboxMode === "audit") {
            result.mode = "audit";
        } else if (sandboxMode === "enforce") {
            result.mode = "enforce";
        }

        // PIZZAPI_SANDBOX_NETWORK overrides network mode
        const netMode = env.PIZZAPI_SANDBOX_NETWORK;
        if (netMode === "off") {
            result.network.mode = "denylist";
            result.network.deniedDomains = [];
            result.network.allowedDomains = [];
        } else if (netMode === "denylist" || netMode === "allowlist") {
            result.network.mode = netMode;
        }

        return result;
    }

    const baseConfig = resolveSandboxConfig("/projects/app", {});

    test("PIZZAPI_SANDBOX=off disables sandbox", () => {
        const result = applyEnvOverrides(baseConfig, { PIZZAPI_SANDBOX: "off" });
        expect(result.mode).toBe("off");
    });

    test("PIZZAPI_SANDBOX=audit forces audit mode", () => {
        const result = applyEnvOverrides(baseConfig, { PIZZAPI_SANDBOX: "audit" });
        expect(result.mode).toBe("audit");
    });

    test("PIZZAPI_SANDBOX=enforce forces enforce mode", () => {
        const result = applyEnvOverrides(baseConfig, { PIZZAPI_SANDBOX: "enforce" });
        expect(result.mode).toBe("enforce");
    });

    test("PIZZAPI_NO_SANDBOX=1 disables sandbox", () => {
        const result = applyEnvOverrides(baseConfig, { PIZZAPI_NO_SANDBOX: "1" });
        expect(result.mode).toBe("off");
    });

    test("PIZZAPI_SANDBOX takes priority over PIZZAPI_NO_SANDBOX", () => {
        // When both are set, PIZZAPI_SANDBOX is processed after NO_SANDBOX
        const result = applyEnvOverrides(baseConfig, {
            PIZZAPI_NO_SANDBOX: "1",
            PIZZAPI_SANDBOX: "audit",
        });
        expect(result.mode).toBe("audit");
    });

    test("PIZZAPI_SANDBOX_NETWORK=off clears all network restrictions", () => {
        const config = resolveSandboxConfig("/projects/app", {
            sandbox: {
                network: {
                    mode: "denylist",
                    deniedDomains: ["evil.com"],
                },
            },
        });
        const result = applyEnvOverrides(config, { PIZZAPI_SANDBOX_NETWORK: "off" });
        expect(result.network.mode).toBe("denylist");
        expect(result.network.deniedDomains).toEqual([]);
        expect(result.network.allowedDomains).toEqual([]);
    });

    test("PIZZAPI_SANDBOX_NETWORK=allowlist switches network mode", () => {
        const result = applyEnvOverrides(baseConfig, {
            PIZZAPI_SANDBOX_NETWORK: "allowlist",
        });
        expect(result.network.mode).toBe("allowlist");
    });

    test("PIZZAPI_SANDBOX_NETWORK=denylist switches network mode", () => {
        const config = resolveSandboxConfig("/projects/app", {
            sandbox: {
                network: { mode: "allowlist", allowedDomains: ["api.example.com"] },
            },
        });
        const result = applyEnvOverrides(config, {
            PIZZAPI_SANDBOX_NETWORK: "denylist",
        });
        expect(result.network.mode).toBe("denylist");
    });

    test("invalid PIZZAPI_SANDBOX value is ignored", () => {
        const result = applyEnvOverrides(baseConfig, { PIZZAPI_SANDBOX: "invalid" });
        expect(result.mode).toBe("enforce"); // unchanged from default
    });

    test("invalid PIZZAPI_SANDBOX_NETWORK value is ignored", () => {
        const result = applyEnvOverrides(baseConfig, {
            PIZZAPI_SANDBOX_NETWORK: "invalid",
        });
        expect(result.network.mode).toBe("denylist"); // unchanged from default
    });

    test("unset env vars leave config unchanged", () => {
        const result = applyEnvOverrides(baseConfig, {});
        expect(result.mode).toBe(baseConfig.mode);
        expect(result.network.mode).toBe(baseConfig.network.mode);
    });
});
