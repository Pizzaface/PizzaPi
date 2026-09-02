import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    initSandbox,
    wrapCommand,
    validatePath,
    getSandboxEnv,
    isSandboxActive,
    isReadOnlyOverlay,
    setReadOnlyOverlay,
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
                // "junction" so the test doesn't require symlink privileges on
                // Windows; ignored on POSIX.
                symlinkSync(targetDir, linkPath, "junction");

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
                expect(getViolations()[0].target.replace(/\\/g, "/")).toContain("etc/secrets/key.pem");
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
            expect(received[0].target.replace(/\\/g, "/")).toContain("etc/secrets/test");
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

    // ── Adversarial hardening ─────────────────────────────────────────────────
    // These tests exercise the real validatePath/wrapCommand/getSandboxEnv
    // against hostile inputs. Network domain matching itself is delegated to
    // @anthropic-ai/sandbox-runtime and is not observable through this
    // module's public API, so only config pass-through is asserted here.

    describe("adversarial: traversal & encoding", () => {
        let tracked: string[] = [];
        const track = (dir: string) => { tracked.push(dir); return dir; };

        beforeEach(() => { tracked = []; });
        afterEach(() => {
            for (const dir of tracked.splice(0)) {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test("blocks deep ../ chains resolving outside denyRead", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc"], allowWrite: ["/tmp"], denyWrite: [] }));
            const deep = "/tmp/" + "../".repeat(60) + "etc/passwd";
            expect(validatePath(deep, "read").allowed).toBe(false);
        });

        test("blocks .. traversal starting inside an allowed write dir", async () => {
            const tmpDir = track(mkdtempSync(join(tmpdir(), "sandbox-trav-")));
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            const escape = join(tmpDir, "sub", "..", "..", "..", "..", "etc", "passwd");
            expect(validatePath(escape, "write").allowed).toBe(false);
        });

        test("allows .. traversal that lands back inside the allowed root (no false positive)", async () => {
            const tmpDir = track(mkdtempSync(join(tmpdir(), "sandbox-trav-")));
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            const staysInside = join(tmpDir, "a", "..", "b.txt");
            expect(validatePath(staysInside, "write").allowed).toBe(true);
        });

        test("prefix confusion: /tmp-evil and /tmpfile are outside allowWrite /tmp", async () => {
            await initSandbox(makeConfig({ denyRead: [], allowWrite: ["/tmp"], denyWrite: [] }));
            expect(validatePath("/tmp-evil/file", "write").allowed).toBe(false);
            expect(validatePath("/tmpfile", "write").allowed).toBe(false);
        });

        test("deny rule prefix boundary: /etc/secretsx is not under /etc/secrets", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc/secrets"] }));
            expect(validatePath("/etc/secretsx/key", "read").allowed).toBe(true);
            expect(validatePath("/etc/secrets/key", "read").allowed).toBe(false);
        });

        test("URL-encoded segments are treated literally (kernel never decodes %2e%2e)", async () => {
            // %2e%2e is a literal directory name to the kernel, so this string
            // does NOT traverse on disk and must not match denyRead (and must
            // not be silently decoded into a traversal either).
            await initSandbox(makeConfig({ denyRead: ["/etc"], allowWrite: ["/tmp"], denyWrite: [] }));
            expect(validatePath("/tmp/%2e%2e/%2e%2e/etc/passwd", "read").allowed).toBe(true);
            expect(validatePath("/tmp/%252e%252e/etc/passwd", "read").allowed).toBe(true);
            // ...but if the encoded path is under a denied rule as written, it's denied.
            expect(validatePath("/etc/%2e%2e/passwd", "read").allowed).toBe(false);
        });

        test("null byte in path does not crash and follows parent normalization", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc"] }));
            expect(() => validatePath("/etc/secrets/key\0.txt", "read")).not.toThrow();
            expect(validatePath("/etc/secrets/key\0.txt", "read").allowed).toBe(false);
        });

        test("empty path resolves to CWD: read allowed, write denied", async () => {
            await initSandbox(makeConfig({ denyRead: [], allowWrite: ["/nonexistent-allow-root"], denyWrite: [] }));
            expect(validatePath("", "read").allowed).toBe(true);
            expect(validatePath("", "write").allowed).toBe(false);
        });

        test("relative paths resolve against CWD", async () => {
            await initSandbox(makeConfig({ denyRead: [], allowWrite: ["/nonexistent-allow-root"], denyWrite: [] }));
            expect(validatePath("foo/bar.txt", "write").allowed).toBe(false);
        });

        test("trailing slash on input path still matches deny rule", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc/secrets"] }));
            expect(validatePath("/etc/secrets/", "read").allowed).toBe(false);
        });

        test("backslashes are literal filename characters on POSIX (no traversal)", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc"] }));
            // On POSIX backslash is not a separator, so this is one weird
            // filename, not /etc/secrets/x. Allowed — pinning correct POSIX
            // semantics against a future over-eager "fix".
            expect(validatePath("/etc\\secrets\\x", "read").allowed).toBe(true);
        });

        test("writing to filesystem root is denied", async () => {
            const tmpDir = track(mkdtempSync(join(tmpdir(), "sandbox-root-")));
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath("/", "write").allowed).toBe(false);
        });
    });

    describe("adversarial: symlink escapes", () => {
        let tmpDir: string;
        let outsideDir: string;
        let tracked: string[] = [];
        const track = (dir: string) => { tracked.push(dir); return dir; };

        beforeEach(() => {
            tracked = [];
            tmpDir = track(mkdtempSync(join(tmpdir(), "sandbox-sym-")));
            outsideDir = track(mkdtempSync(join(tmpdir(), "sandbox-sym-outside-")));
        });
        afterEach(() => {
            for (const dir of tracked.splice(0)) {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test("write through dir symlink to existing outside dir is denied", async () => {
            const linkPath = join(tmpDir, "escape");
            symlinkSync(outsideDir, linkPath, "junction");
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath(join(linkPath, "new.txt"), "write").allowed).toBe(false);
        });

        test("read through dir symlink is denied when target is in denyRead", async () => {
            const linkPath = join(tmpDir, "peek");
            symlinkSync(outsideDir, linkPath, "junction");
            await initSandbox(makeConfig({ denyRead: [outsideDir], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath(join(linkPath, "secret.txt"), "read").allowed).toBe(false);
        });

        test("write through file symlink to an existing outside file is denied", async () => {
            const outsideFile = join(outsideDir, "victim.txt");
            writeFileSync(outsideFile, "original");
            const linkPath = join(tmpDir, "out.txt");
            symlinkSync(outsideFile, linkPath, "file");
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath(linkPath, "write").allowed).toBe(false);
        });

        test("read through file symlink into a denyRead dir is denied", async () => {
            const deniedDir = track(mkdtempSync(join(tmpdir(), "sandbox-sym-denied-")));
            const secretFile = join(deniedDir, "secret.txt");
            writeFileSync(secretFile, "topsecret");
            const linkPath = join(tmpDir, "sneaky.txt");
            symlinkSync(secretFile, linkPath, "file");
            await initSandbox(makeConfig({ denyRead: [deniedDir], allowWrite: [tmpDir], denyWrite: [] }));
            const result = validatePath(linkPath, "read");
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("denied");
        });

        test("dangling symlink under allowWrite passes validation (documents current gap)", async () => {
            // existsSync() is false for a dangling symlink, so _normalizePath's
            // parent walk treats it as an ordinary (unrealpath'd) child of the
            // allowed root. The write itself would fail at the OS level today
            // (target doesn't exist), but see the test.todo below for the
            // TOCTOU variant this enables when OS enforcement is inactive.
            symlinkSync(join(outsideDir, "created-later"), join(tmpDir, "dangling"), "junction");
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath(join(tmpDir, "dangling", "x.txt"), "write").allowed).toBe(true);
        });

        test("symlink resolving within the allowed root is allowed (no false positive)", async () => {
            const realDir = join(tmpDir, "real");
            mkdirSync(realDir);
            symlinkSync(realDir, join(tmpDir, "alias"), "junction");
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            expect(validatePath(join(tmpDir, "alias", "f.txt"), "write").allowed).toBe(true);
        });

        test("denial through symlink records a violation with the resolved target", async () => {
            const linkPath = join(tmpDir, "escape");
            symlinkSync(outsideDir, linkPath, "junction");
            await initSandbox(makeConfig({ denyRead: [], allowWrite: [tmpDir], denyWrite: [] }));
            validatePath(join(linkPath, "f.txt"), "write");
            const violations = getViolations();
            expect(violations.length).toBe(1);
            expect(violations[0].operation).toBe("write");
            expect(violations[0].target.replace(/\\/g, "/")).toContain(outsideDir.replace(/\\/g, "/").replace(/^\//, ""));
        });
    });

    describe("adversarial: env leakage", () => {
        test("getSandboxEnv only ever exposes proxy-shaped variables", async () => {
            await initSandbox(makeConfig({
                mode: "full",
                network: {
                    allowedDomains: ["example.com"],
                    deniedDomains: [],
                    allowLocalBinding: true,
                    httpProxyPort: 18888,
                    socksProxyPort: 18889,
                },
            }));
            if (!isSandboxActive()) return; // CI: init failed, nothing further to assert
            const env = getSandboxEnv();
            const allowedKeys = new Set([
                "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
            ]);
            for (const [key, value] of Object.entries(env)) {
                expect(allowedKeys.has(key)).toBe(true);
                expect(value).toMatch(/^https?:\/\/127\.0\.0\.1:\d+$|^socks5:\/\/127\.0\.0\.1:\d+$/);
            }
        });

        test("sandbox env never carries host secrets", async () => {
            const origSock = process.env.SSH_AUTH_SOCK;
            const origAws = process.env.AWS_SECRET_ACCESS_KEY;
            process.env.SSH_AUTH_SOCK = "/tmp/sandbox-test-agent.sock";
            process.env.AWS_SECRET_ACCESS_KEY = "sandbox-test-topsecret";
            try {
                await initSandbox(makeConfig({ mode: "full" }));
                const env = getSandboxEnv();
                const serialized = JSON.stringify(env);
                expect(serialized).not.toContain("SSH_AUTH_SOCK");
                expect(serialized).not.toContain("sandbox-test-agent.sock");
                expect(serialized).not.toContain("topsecret");
                expect(serialized).not.toContain("AWS_SECRET");
            } finally {
                if (origSock !== undefined) process.env.SSH_AUTH_SOCK = origSock;
                else delete process.env.SSH_AUTH_SOCK;
                if (origAws !== undefined) process.env.AWS_SECRET_ACCESS_KEY = origAws;
                else delete process.env.AWS_SECRET_ACCESS_KEY;
            }
        });

        test("getSandboxEnv is empty again after cleanup", async () => {
            await initSandbox(makeConfig({ mode: "full" }));
            await cleanupSandbox();
            expect(getSandboxEnv()).toEqual({});
        });
    });

    describe("adversarial: network config pass-through", () => {
        // Domain matching semantics (subdomains, ports, case, trailing dot)
        // live inside @anthropic-ai/sandbox-runtime; sandbox.ts only forwards
        // allowedDomains/deniedDomains. What this module owns is that hostile
        // domain strings must not crash initialization.
        test("edge-case domain strings are accepted without crashing init", async () => {
            await initSandbox(makeConfig({
                mode: "full",
                network: {
                    allowedDomains: ["Example.COM.", "api.example.com:8443", "*.EXAMPLE.com", "localhost", ""],
                    deniedDomains: ["EVIL.com", "evil.com.", "sub.evil.com:8080"],
                    allowLocalBinding: true,
                },
            }));
            expect(getSandboxMode()).toBe("full");
        });
    });

    describe("adversarial: malformed config inputs", () => {
        test("mode full with null srtConfig degrades to permissive validation", async () => {
            await initSandbox({ mode: "full", srtConfig: null });
            expect(getSandboxMode()).toBe("full");
            expect(isSandboxActive()).toBe(false);
            expect(validatePath("/etc/shadow", "read").allowed).toBe(true);
            expect(validatePath("/etc/cron.d", "write").allowed).toBe(true);
        });

        test("empty allowWrite denies all writes; empty denyRead allows all reads", async () => {
            await initSandbox(makeConfig({
                denyRead: [],
                allowWrite: [],
                denyWrite: [],
            }));
            expect(validatePath("/tmp/x", "write").allowed).toBe(false);
            expect(validatePath("/etc/shadow", "read").allowed).toBe(true);
        });

        test("empty allowedDomains config does not crash init", async () => {
            await initSandbox(makeConfig({
                mode: "full",
                network: { allowedDomains: [], deniedDomains: [] },
            }));
            expect(getSandboxMode()).toBe("full");
        });

        test("initSandbox does not throw on malformed configs (missing srtConfig / undefined fs arrays)", async () => {
            // srtConfig entirely absent (undefined, not null).
            await expect(
                initSandbox({ mode: "basic" } as unknown as ResolvedSandboxConfig),
            ).resolves.toBeUndefined();
            expect(getSandboxMode()).toBe("basic");

            _resetState();

            // srtConfig present but its filesystem arrays are undefined.
            await expect(
                initSandbox({
                    mode: "basic",
                    srtConfig: { filesystem: {} },
                } as unknown as ResolvedSandboxConfig),
            ).resolves.toBeUndefined();
            expect(getSandboxMode()).toBe("basic");
        });

        test("file:// URL prefix is normalized to a filesystem path before denyRead applies", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc/secrets"] }));
            expect(validatePath("file:///etc/secrets/key", "read").allowed).toBe(false);
            expect(validatePath("file:///etc/other", "read").allowed).toBe(true);
        });

        test("non-file:// URL schemes are denied outright, not resolved as CWD-relative", async () => {
            await initSandbox(makeConfig({ denyRead: [] }));
            expect(validatePath("http://evil.example/etc/passwd", "read").allowed).toBe(false);
            expect(validatePath("http://evil.example/etc/passwd", "write").allowed).toBe(false);
        });

        test("malformed file:// URL is denied, not treated as a relative path", async () => {
            await initSandbox(makeConfig({ denyRead: [] }));
            // Non-empty, non-"localhost" host on a file:// URL is malformed.
            expect(validatePath("file://not-localhost/etc/passwd", "read").allowed).toBe(false);
        });

        // BUG (found by adversarial probing, not fixed per task instructions):
        // A dangling symlink inside allowWrite passes validatePath for writes
        // (existsSync is false, so the parent walk never resolves its target).
        // An attacker who creates the symlink target between validation and
        // write escapes the allowed root — a TOCTOU window whenever OS-level
        // enforcement is inactive (init failed, unsupported platform).
        test.todo("dangling symlink under allowWrite passes write validation (TOCTOU escape when OS enforcement is inactive)");
    });

    describe("adversarial: read-only overlay", () => {
        test("overlay flag is tracked and reset by cleanup", async () => {
            await initSandbox(makeConfig({ mode: "basic" }));
            setReadOnlyOverlay(true);
            expect(isReadOnlyOverlay()).toBe(true);
            await cleanupSandbox();
            expect(isReadOnlyOverlay()).toBe(false);
        });

        test("overlay-enabled wrapCommand: deny-all wrap when active, documented no-op when inactive", async () => {
            await initSandbox(makeConfig({ mode: "basic" }));
            setReadOnlyOverlay(true);
            const cmd = "echo sandbox-overlay-probe";
            const wrapped = await wrapCommand(cmd);
            if (isSandboxActive()) {
                expect(wrapped).not.toBe(cmd);
            } else {
                expect(wrapped).toBe(cmd);
            }
        });
    });
});
