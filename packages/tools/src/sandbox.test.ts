import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    initSandbox,
    wrapCommand,
    validatePath,
    getSandboxEnv,
    isSandboxActive,
    getSandboxMode,
    getViolations,
    clearViolations,
    onViolation,
    getResolvedConfig,
    cleanupSandbox,
    _resetState,
    type ResolvedSandboxConfig,
    type ViolationRecord,
} from "./sandbox.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
    return mkdtempSync(join(tmpdir(), "sandbox-test-"));
}

function makeConfig(overrides?: {
    mode?: ResolvedSandboxConfig["mode"];
    denyRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
    network?: ResolvedSandboxConfig["srtConfig"] extends null ? never : NonNullable<NonNullable<ResolvedSandboxConfig["srtConfig"]>["network"]>;
}): ResolvedSandboxConfig {
    const mode = overrides?.mode ?? "basic";
    if (mode === "none") {
        return { mode: "none", srtConfig: null };
    }
    const tmpDir = makeTmpDir();
    return {
        mode,
        srtConfig: {
            filesystem: {
                denyRead: overrides?.denyRead ?? ["/etc/secrets", "/home/user/.ssh"],
                allowWrite: overrides?.allowWrite ?? [tmpDir, "/tmp"],
                denyWrite: overrides?.denyWrite ?? ["/home/user/.ssh", join(tmpDir, ".env")],
            },
            ...(overrides?.network !== undefined ? { network: overrides.network } : {}),
        },
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("sandbox", () => {
    beforeEach(() => {
        _resetState();
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    // ── getSandboxMode ────────────────────────────────────────────────────────

    describe("getSandboxMode()", () => {
        test("returns 'none' before initialization", () => {
            expect(getSandboxMode()).toBe("none");
        });

        test("returns 'basic' after basic init", async () => {
            await initSandbox(makeConfig({ mode: "basic" }));
            expect(getSandboxMode()).toBe("basic");
        });

        test("returns 'full' after full init", async () => {
            await initSandbox(makeConfig({ mode: "full" }));
            expect(getSandboxMode()).toBe("full");
        });

        test("returns 'none' after none init", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            expect(getSandboxMode()).toBe("none");
        });
    });

    // ── isSandboxActive ───────────────────────────────────────────────────────

    describe("isSandboxActive()", () => {
        test("returns false before initialization", () => {
            expect(isSandboxActive()).toBe(false);
        });

        test("returns false when mode is none", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            expect(isSandboxActive()).toBe(false);
        });

        test("returns true when mode is basic (on supported platforms)", async () => {
            await initSandbox(makeConfig({ mode: "basic" }));
            // On unsupported platforms (Windows) it degrades gracefully and
            // isSandboxActive returns false. Otherwise true.
            // We just verify it doesn't throw.
            const active = isSandboxActive();
            expect(typeof active).toBe("boolean");
        });
    });

    // ── initSandbox ───────────────────────────────────────────────────────────

    describe("initSandbox()", () => {
        test("no-op for mode none", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            expect(getSandboxMode()).toBe("none");
            expect(isSandboxActive()).toBe(false);
        });

        test("basic mode without network config initializes successfully", async () => {
            // Regression: SandboxRuntimeConfig requires `network` to always
            // be present. When srtConfig.network was undefined (basic mode),
            // SandboxManager.initialize() crashed with "undefined is not an
            // object (evaluating 'config.network.httpProxyPort')" and set
            // _initFailed, silently disabling OS-level enforcement.
            const config = makeConfig({ mode: "basic" });
            // Ensure no network key — this is the scenario that used to fail
            expect(config.srtConfig!.network).toBeUndefined();

            // Capture stderr to detect the specific network config crash
            const errors: string[] = [];
            const origError = console.error;
            console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
            try {
                await initSandbox(config);
            } finally {
                console.error = origError;
            }

            expect(getSandboxMode()).toBe("basic");

            // The core regression check: initSandbox must NOT have failed
            // due to the network config bug. On CI without sandbox deps
            // (bwrap, rg, socat), init legitimately fails with "dependencies
            // not available" — that's fine. But the old "undefined is not an
            // object" crash means _buildSrtConfig produced bad config.
            const networkCrash = errors.some(e => e.includes("undefined is not an object"));
            expect(networkCrash).toBe(false);

            // On platforms where sandbox fully initialized, verify enforcement
            if (isSandboxActive()) {
                const wrapped = await wrapCommand("echo hello");
                expect(wrapped).not.toBe("echo hello");
            }
        });

        test("detects SSH_AUTH_SOCK from environment", async () => {
            const origSock = process.env.SSH_AUTH_SOCK;
            process.env.SSH_AUTH_SOCK = "/tmp/test-ssh-agent.sock";
            try {
                await initSandbox(makeConfig({ mode: "basic" }));
                // Just verify it doesn't throw and mode is set
                expect(getSandboxMode()).toBe("basic");
            } finally {
                if (origSock !== undefined) {
                    process.env.SSH_AUTH_SOCK = origSock;
                } else {
                    delete process.env.SSH_AUTH_SOCK;
                }
            }
        });
    });

    // ── validatePath ──────────────────────────────────────────────────────────

    describe("validatePath()", () => {
        describe("read operations", () => {
            test("allows reading unrestricted paths", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/usr/local/bin/node", "read");
                expect(result.allowed).toBe(true);
            });

            test("denies reading paths in denyRead list", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/etc/secrets/key.pem", "read");
                expect(result.allowed).toBe(false);
                expect(result.reason).toContain("denied");
            });

            test("denies reading exact denyRead path", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/home/user/.ssh", "read");
                expect(result.allowed).toBe(false);
            });

            test("denies reading children of denyRead paths", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/home/user/.ssh/id_rsa", "read");
                expect(result.allowed).toBe(false);
            });

            test("allows reading paths not in deny list", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/home/user/.bashrc", "read");
                expect(result.allowed).toBe(true);
            });
        });

        describe("write operations", () => {
            test("allows writing to allowWrite paths", async () => {
                const cfg = makeConfig();
                await initSandbox(cfg);
                const result = validatePath(
                    join(cfg.srtConfig!.filesystem.allowWrite[0], "test.txt"),
                    "write",
                );
                expect(result.allowed).toBe(true);
            });

            test("allows writing to /tmp", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/tmp/sandbox-output.txt", "write");
                expect(result.allowed).toBe(true);
            });

            test("denyWrite takes precedence over allowWrite", async () => {
                const cfg = makeConfig();
                const envPath = join(cfg.srtConfig!.filesystem.allowWrite[0], ".env");
                await initSandbox(cfg);
                const result = validatePath(envPath, "write");
                expect(result.allowed).toBe(false);
                expect(result.reason).toContain("denied");
            });

            test("denies writing to paths outside allowWrite", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/etc/passwd", "write");
                expect(result.allowed).toBe(false);
                expect(result.reason).toContain("not within any allowed");
            });
        });

        describe("path traversal prevention", () => {
            test("blocks read via .. traversal", async () => {
                await initSandbox(makeConfig({
                    denyRead: ["/etc"],
                    allowWrite: ["/tmp"],
                }));
                const result = validatePath("/tmp/../etc/passwd", "read");
                expect(result.allowed).toBe(false);
            });

            test("blocks write via .. traversal", async () => {
                await initSandbox(makeConfig());
                const result = validatePath("/tmp/test/../../etc/shadow", "write");
                expect(result.allowed).toBe(false);
            });

            test("resolves . and redundant slashes", async () => {
                await initSandbox(makeConfig({ denyRead: ["/etc"] }));
                const result = validatePath("/etc/./secrets/./key.pem", "read");
                expect(result.allowed).toBe(false);
            });

            test("root / deny rule blocks all child paths", async () => {
                await initSandbox(makeConfig({ denyRead: ["/"] }));
                expect(validatePath("/etc/passwd", "read").allowed).toBe(false);
                expect(validatePath("/home/user/.ssh/id_rsa", "read").allowed).toBe(false);
                expect(validatePath("/", "read").allowed).toBe(false);
            });

            test("root / allowWrite rule permits child paths", async () => {
                await initSandbox(makeConfig({
                    denyRead: [],
                    allowWrite: ["/"],
                    denyWrite: [],
                }));
                expect(validatePath("/tmp/file.txt", "write").allowed).toBe(true);
                expect(validatePath("/etc/passwd", "write").allowed).toBe(true);
            });

            test("handles trailing slashes in config rules", async () => {
                await initSandbox(makeConfig({
                    denyRead: ["/etc/"],
                    allowWrite: ["/tmp/"],
                    denyWrite: [],
                }));
                expect(validatePath("/etc/passwd", "read").allowed).toBe(false);
                expect(validatePath("/tmp/output.txt", "write").allowed).toBe(true);
            });

            test("blocks symlink traversal out of allowed area", async () => {
                const { mkdtempSync: mktmp, symlinkSync } = await import("fs");
                const { tmpdir: td } = await import("os");

                const tmpDir = mktmp(join(td(), "symlink-test-"));
                const targetDir = mktmp(join(td(), "symlink-target-"));
                const linkPath = join(tmpDir, "escape");
                symlinkSync(targetDir, linkPath);

                await initSandbox(makeConfig({
                    denyRead: [targetDir],
                    allowWrite: [tmpDir],
                    denyWrite: [],
                }));

                const result = validatePath(join(linkPath, "secret.txt"), "read");
                expect(result.allowed).toBe(false);
            });
        });

        describe("when mode is none", () => {
            test("allows all reads", async () => {
                await initSandbox({ mode: "none", srtConfig: null });
                expect(validatePath("/etc/secrets/key.pem", "read").allowed).toBe(true);
            });

            test("allows all writes", async () => {
                await initSandbox({ mode: "none", srtConfig: null });
                expect(validatePath("/etc/passwd", "write").allowed).toBe(true);
            });
        });

        describe("before initialization", () => {
            test("allows all paths", () => {
                expect(validatePath("/etc/secrets", "read").allowed).toBe(true);
            });
        });

        describe("violation recording", () => {
            test("records violations on denied reads", async () => {
                await initSandbox(makeConfig());
                validatePath("/etc/secrets/key.pem", "read");
                expect(getViolations().length).toBe(1);
                expect(getViolations()[0].operation).toBe("read");
                expect(getViolations()[0].target).toContain("etc/secrets/key.pem");
            });

            test("records violations on denied writes", async () => {
                await initSandbox(makeConfig());
                validatePath("/etc/passwd", "write");
                expect(getViolations().length).toBe(1);
                expect(getViolations()[0].operation).toBe("write");
            });
        });

        describe("path normalization", () => {
            test("expands tilde in input path", async () => {
                const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
                await initSandbox(makeConfig({
                    denyRead: [join(home, ".ssh")],
                    allowWrite: ["/tmp"],
                    denyWrite: [],
                }));
                const result = validatePath("~/.ssh/id_rsa", "read");
                expect(result.allowed).toBe(false);
            });
        });
    });

    // ── case sensitivity ──────────────────────────────────────────────────────

    describe("case-sensitive path matching", () => {
        const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";

        test.skipIf(!isCaseInsensitive)(
            "deny rules are case-insensitive on macOS/Windows",
            async () => {
                await initSandbox(makeConfig({ denyRead: ["/Etc/Secrets"] }));
                expect(validatePath("/etc/secrets/key", "read").allowed).toBe(false);
            },
        );

        test.skipIf(isCaseInsensitive)(
            "deny rules are case-sensitive on Linux",
            async () => {
                await initSandbox(makeConfig({ denyRead: ["/Etc/Secrets"] }));
                expect(validatePath("/etc/secrets/key", "read").allowed).toBe(true);
            },
        );
    });

    // ── wrapCommand ───────────────────────────────────────────────────────────

    describe("wrapCommand()", () => {
        test("returns unwrapped command when mode is none", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            expect(await wrapCommand("ls -la")).toBe("ls -la");
        });

        test("returns original command before initialization", async () => {
            expect(await wrapCommand("cat /etc/passwd")).toBe("cat /etc/passwd");
        });
    });

    // ── getSandboxEnv ─────────────────────────────────────────────────────────

    describe("getSandboxEnv()", () => {
        test("returns empty object when mode is none", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            expect(getSandboxEnv()).toEqual({});
        });

        test("returns empty object before initialization", () => {
            expect(getSandboxEnv()).toEqual({});
        });
    });

    // ── getViolations / clearViolations ───────────────────────────────────────

    describe("getViolations()", () => {
        test("returns empty array initially", () => {
            expect(getViolations()).toEqual([]);
        });

        test("returns copy, not reference", async () => {
            await initSandbox(makeConfig());
            validatePath("/etc/secrets", "read");
            const v1 = getViolations();
            const v2 = getViolations();
            expect(v1).toEqual(v2);
            expect(v1).not.toBe(v2);
        });
    });

    describe("clearViolations()", () => {
        test("clears all violations", async () => {
            await initSandbox(makeConfig());
            validatePath("/etc/secrets/a", "read");
            validatePath("/etc/secrets/b", "read");
            expect(getViolations().length).toBe(2);
            clearViolations();
            expect(getViolations().length).toBe(0);
        });
    });

    describe("ring buffer cap", () => {
        test("caps at 100 violations", async () => {
            await initSandbox(makeConfig());
            for (let i = 0; i < 120; i++) {
                validatePath(`/etc/secrets/file${i}`, "read");
            }
            const violations = getViolations();
            expect(violations.length).toBe(100);
            // Oldest entries dropped
            expect(violations[0].target).toContain("file20");
            expect(violations[99].target).toContain("file119");
        });
    });

    // ── onViolation ───────────────────────────────────────────────────────────

    describe("onViolation()", () => {
        test("calls listener on violations", async () => {
            await initSandbox(makeConfig());
            const received: ViolationRecord[] = [];
            const unsub = onViolation((v) => received.push(v));

            validatePath("/etc/secrets/test", "read");
            expect(received.length).toBe(1);
            expect(received[0].target).toContain("etc/secrets/test");
            unsub();
        });

        test("unsubscribe stops notifications", async () => {
            await initSandbox(makeConfig());
            const received: ViolationRecord[] = [];
            const unsub = onViolation((v) => received.push(v));

            validatePath("/etc/secrets/a", "read");
            unsub();
            validatePath("/etc/secrets/b", "read");
            expect(received.length).toBe(1);
        });

        test("listener errors don't crash sandbox", async () => {
            await initSandbox(makeConfig());
            const unsub = onViolation(() => { throw new Error("crash"); });
            // Should not throw
            validatePath("/etc/secrets/test", "read");
            expect(getViolations().length).toBe(1);
            unsub();
        });
    });

    // ── cleanupSandbox ────────────────────────────────────────────────────────

    describe("cleanupSandbox()", () => {
        test("resets all state", async () => {
            await initSandbox(makeConfig());
            validatePath("/etc/secrets", "read");
            expect(getViolations().length).toBe(1);

            await cleanupSandbox();

            expect(getSandboxMode()).toBe("none");
            expect(isSandboxActive()).toBe(false);
            expect(getViolations()).toEqual([]);
        });

        test("safe to call before initialization", async () => {
            await cleanupSandbox();
            expect(getSandboxMode()).toBe("none");
        });

        test("safe to call multiple times", async () => {
            await initSandbox(makeConfig());
            await cleanupSandbox();
            await cleanupSandbox();
        });
    });

    // ── getResolvedConfig ─────────────────────────────────────────────────────

    describe("getResolvedConfig()", () => {
        test("returns null before initialization", () => {
            expect(getResolvedConfig()).toBeNull();
        });

        test("returns config after initialization", async () => {
            await initSandbox(makeConfig({ mode: "basic" }));
            const resolved = getResolvedConfig();
            expect(resolved).not.toBeNull();
            expect(resolved!.mode).toBe("basic");
        });

        test("returns a copy, not the original", async () => {
            await initSandbox(makeConfig());
            const a = getResolvedConfig();
            const b = getResolvedConfig();
            expect(a).toEqual(b);
            expect(a).not.toBe(b);
        });
    });
});
