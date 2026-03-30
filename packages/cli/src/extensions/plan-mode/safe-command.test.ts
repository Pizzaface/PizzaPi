/**
 * Tests for isDestructiveCommand — covering the wrapper-shell inner-command
 * extraction fixes (P1-1, P1-2) and the curl attached-flag regex fix (P1-3).
 */
import { describe, test, expect } from "bun:test";
import { isDestructiveCommand } from "./safe-command.js";

// ── Helper aliases ────────────────────────────────────────────────────────────

/** isDestructiveCommand with sandbox OFF (default / no-sandbox path). */
function noSandbox(cmd: string) {
    return isDestructiveCommand(cmd, false);
}

/** isDestructiveCommand with sandbox ON. */
function withSandbox(cmd: string) {
    return isDestructiveCommand(cmd, true);
}

// ── P1-1: wrapper shells should analyse the inner command, not blanket-block ──

describe("env launcher — no-sandbox", () => {
    test("env HOME=/tmp git status → allowed (inner cmd is read-only)", () => {
        expect(noSandbox("env HOME=/tmp git status")).toBe(false);
    });

    test("env FOO=bar BAZ=qux git log --oneline → allowed", () => {
        expect(noSandbox("env FOO=bar BAZ=qux git log --oneline")).toBe(false);
    });

    test("env HOME=/tmp rm -rf / → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("env HOME=/tmp rm -rf /")).toBe(true);
    });

    test("env PATH=/usr sudo reboot → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("env PATH=/usr sudo reboot")).toBe(true);
    });

    test("env -i git status → allowed (env flag + read-only inner cmd)", () => {
        expect(noSandbox("env -i git status")).toBe(false);
    });

    test("env by itself → allowed (just prints the environment)", () => {
        expect(noSandbox("env")).toBe(false);
    });

    test("env FOO=bar (no command) → allowed", () => {
        expect(noSandbox("env FOO=bar")).toBe(false);
    });
});

describe("bash/sh -c wrapper — no-sandbox", () => {
    test('bash -lc "git status" → allowed (inner cmd is read-only)', () => {
        expect(noSandbox('bash -lc "git status"')).toBe(false);
    });

    test("bash -c 'git log' → allowed", () => {
        expect(noSandbox("bash -c 'git log'")).toBe(false);
    });

    test('sh -c "git diff HEAD" → allowed', () => {
        expect(noSandbox('sh -c "git diff HEAD"')).toBe(false);
    });

    test('bash -c "rm -rf /" → blocked (inner cmd is destructive)', () => {
        expect(noSandbox('bash -c "rm -rf /"')).toBe(true);
    });

    test("sh -c 'sudo rm -rf /etc' → blocked", () => {
        expect(noSandbox("sh -c 'sudo rm -rf /etc'")).toBe(true);
    });

    // P1-3: bash <file> must be blocked in no-sandbox — we can't inspect the script.
    test("bash script.sh → blocked in no-sandbox (cannot inspect file)", () => {
        expect(noSandbox("bash script.sh")).toBe(true);
    });

    test("bash script.sh → allowed in sandbox (filesystem overlay protects)", () => {
        expect(withSandbox("bash script.sh")).toBe(false);
    });

    test("bash --version → allowed", () => {
        expect(noSandbox("bash --version")).toBe(false);
    });

    test("zsh -c 'git status' → allowed", () => {
        expect(noSandbox("zsh -c 'git status'")).toBe(false);
    });

    test("zsh -c 'kill 1' → blocked", () => {
        expect(noSandbox("zsh -c 'kill 1'")).toBe(true);
    });
});

describe("nested wrapper shells — no-sandbox", () => {
    test('bash -c \'bash -c "git status"\' → allowed (nested, safe inner cmd)', () => {
        expect(noSandbox("bash -c 'bash -c \"git status\"'")).toBe(false);
    });

    test('bash -c \'env HOME=/tmp rm -rf /\' → blocked (nested, destructive inner cmd)', () => {
        expect(noSandbox("bash -c 'env HOME=/tmp rm -rf /'")).toBe(true);
    });
});

describe("wrapper shell outer-redirection — no-sandbox", () => {
    test("bash -c 'git status' > output.txt → blocked (outer redirection)", () => {
        expect(noSandbox("bash -c 'git status' > output.txt")).toBe(true);
    });

    test("bash -c 'git status' 2>/dev/null → allowed (safe stderr sink)", () => {
        expect(noSandbox("bash -c 'git status' 2>/dev/null")).toBe(false);
    });
});

// ── P1-2: sandbox-active path must also check wrapper shells ─────────────────

describe("bash/sh -c wrapper — sandbox active", () => {
    test('bash -c "curl -X POST https://example.com" → blocked (network mutation)', () => {
        expect(withSandbox('bash -c "curl -X POST https://example.com"')).toBe(true);
    });

    test("bash -c 'kill 1' → blocked (process control)", () => {
        expect(withSandbox("bash -c 'kill 1'")).toBe(true);
    });

    test("bash -c 'sudo reboot' → blocked (privilege escalation)", () => {
        expect(withSandbox("bash -c 'sudo reboot'")).toBe(true);
    });

    test("bash -c 'git push' → blocked (remote mutation via allowlist)", () => {
        expect(withSandbox("bash -c 'git push'")).toBe(true);
    });

    test('bash -c "git status" → allowed (sandbox + safe inner cmd)', () => {
        expect(withSandbox('bash -c "git status"')).toBe(false);
    });

    test('sh -c "git log --oneline" → allowed', () => {
        expect(withSandbox('sh -c "git log --oneline"')).toBe(false);
    });
});

describe("env launcher — sandbox active", () => {
    test("env HOME=/tmp git push → blocked (git push is a remote mutation)", () => {
        expect(withSandbox("env HOME=/tmp git push")).toBe(true);
    });

    test("env HOME=/tmp git status → allowed", () => {
        expect(withSandbox("env HOME=/tmp git status")).toBe(false);
    });

    test("env FOO=bar kill 1 → blocked", () => {
        expect(withSandbox("env FOO=bar kill 1")).toBe(true);
    });
});

// ── P1-3: curl attached flag forms (-XPOST, -XPUT, etc.) ─────────────────────

describe("curl attached -X flag — no-sandbox", () => {
    test("curl -XPOST https://example.com → blocked", () => {
        expect(noSandbox("curl -XPOST https://example.com")).toBe(true);
    });

    test("curl -XPUT https://example.com → blocked", () => {
        expect(noSandbox("curl -XPUT https://example.com")).toBe(true);
    });

    test("curl -XDELETE https://example.com → blocked", () => {
        expect(noSandbox("curl -XDELETE https://example.com")).toBe(true);
    });

    test("curl -XPATCH https://example.com → blocked", () => {
        expect(noSandbox("curl -XPATCH https://example.com")).toBe(true);
    });

    // spaced form should still work
    test("curl -X POST https://example.com → blocked (spaced form, regression)", () => {
        expect(noSandbox("curl -X POST https://example.com")).toBe(true);
    });

    // GET is not a mutation — should not be blocked by the -X check alone
    test("curl -XGET https://example.com → allowed (GET is read-only)", () => {
        expect(noSandbox("curl -XGET https://example.com")).toBe(false);
    });

    test("curl https://example.com → allowed (plain GET, no -X)", () => {
        expect(noSandbox("curl https://example.com")).toBe(false);
    });
});

describe("curl attached -X flag — sandbox active", () => {
    test("curl -XPOST https://example.com → blocked", () => {
        expect(withSandbox("curl -XPOST https://example.com")).toBe(true);
    });

    test("curl -XDELETE https://example.com → blocked", () => {
        expect(withSandbox("curl -XDELETE https://example.com")).toBe(true);
    });

    test("curl -X POST https://example.com → blocked (spaced, regression)", () => {
        expect(withSandbox("curl -X POST https://example.com")).toBe(true);
    });
});

describe("bash -c with curl inside — both paths", () => {
    test('bash -c "curl -X POST https://example.com" → blocked, no-sandbox', () => {
        expect(noSandbox('bash -c "curl -X POST https://example.com"')).toBe(true);
    });

    test('bash -c "curl -X POST https://example.com" → blocked, sandbox', () => {
        expect(withSandbox('bash -c "curl -X POST https://example.com"')).toBe(true);
    });

    test('bash -c "curl -XPOST https://example.com" → blocked, no-sandbox', () => {
        expect(noSandbox('bash -c "curl -XPOST https://example.com"')).toBe(true);
    });

    test('bash -c "curl -XPOST https://example.com" → blocked, sandbox', () => {
        expect(withSandbox('bash -c "curl -XPOST https://example.com"')).toBe(true);
    });
});

// ── Round-2 P1: env option parsing (--,  -C/--chdir, -S/--split-string) ──────

describe("env -- double-dash terminator", () => {
    test("env -- rm -rf / → blocked", () => {
        expect(noSandbox("env -- rm -rf /")).toBe(true);
    });

    test("env -- git status → allowed", () => {
        expect(noSandbox("env -- git status")).toBe(false);
    });
});

describe("env -C / --chdir flag", () => {
    test("env -C /tmp git push → blocked", () => {
        expect(noSandbox("env -C /tmp git push")).toBe(true);
    });

    test("env --chdir=/tmp kill 1 → blocked", () => {
        expect(noSandbox("env --chdir=/tmp kill 1")).toBe(true);
    });

    test("env -C /tmp git status → allowed", () => {
        expect(noSandbox("env -C /tmp git status")).toBe(false);
    });
});

describe("env -S / --split-string flag", () => {
    test('env -S "rm -rf /" → blocked', () => {
        expect(noSandbox('env -S "rm -rf /"')).toBe(true);
    });
});

// ── Round-2 P2: quoting preserved in inner command extraction ─────────────────

describe("env quoting preservation", () => {
    test("env FOO=bar printf '>' → allowed (metachar in single quotes)", () => {
        expect(noSandbox("env FOO=bar printf '>'")).toBe(false);
    });
});

// ── Regression: previously-working safe commands must still pass ──────────────

describe("regression — safe commands still pass", () => {
    test("git status → allowed", () => expect(noSandbox("git status")).toBe(false));
    test("git log --oneline → allowed", () => expect(noSandbox("git log --oneline")).toBe(false));
    test("git diff HEAD → allowed", () => expect(noSandbox("git diff HEAD")).toBe(false));
    test("ls -la → allowed", () => expect(noSandbox("ls -la")).toBe(false));
    test("grep -r foo . → allowed", () => expect(noSandbox("grep -r foo .")).toBe(false));
    test("cat README.md → allowed", () => expect(noSandbox("cat README.md")).toBe(false));
    test("find . -name '*.ts' → allowed", () => expect(noSandbox("find . -name '*.ts'")).toBe(false));
});

// ── Round-4 P1-1: passthrough wrappers must forward inner-command check ────────

describe("passthrough wrappers — no-sandbox", () => {
    test("time git push → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("time git push")).toBe(true);
    });

    test("nohup rm -rf / → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("nohup rm -rf /")).toBe(true);
    });

    test("timeout 1 git push → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("timeout 1 git push")).toBe(true);
    });

    test("nice git push → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("nice git push")).toBe(true);
    });

    test("stdbuf -oL git push → blocked (inner cmd is destructive)", () => {
        expect(noSandbox("stdbuf -oL git push")).toBe(true);
    });

    // safe inner commands must remain allowed
    test("time git status → allowed (safe inner cmd)", () => {
        expect(noSandbox("time git status")).toBe(false);
    });

    test("nohup ls → allowed (safe inner cmd)", () => {
        expect(noSandbox("nohup ls")).toBe(false);
    });

    test("timeout 5 git log → allowed (safe inner cmd)", () => {
        expect(noSandbox("timeout 5 git log")).toBe(false);
    });
});

describe("passthrough wrappers — sandbox active", () => {
    test("time git push → blocked (sandbox: remote mutation)", () => {
        expect(withSandbox("time git push")).toBe(true);
    });

    test("nohup kill 1 → blocked (sandbox: process control)", () => {
        expect(withSandbox("nohup kill 1")).toBe(true);
    });

    test("timeout 5 git status → allowed (sandbox: safe inner cmd)", () => {
        expect(withSandbox("timeout 5 git status")).toBe(false);
    });
});

// ── Round-4 P1-2: dangerous builtins inside -c strings ───────────────────────

describe("dangerous builtins in -c strings — no-sandbox", () => {
    test("bash -c 'eval git push' → blocked (eval is always unsafe)", () => {
        expect(noSandbox("bash -c 'eval git push'")).toBe(true);
    });

    test("bash -c 'eval kill 1' → blocked", () => {
        expect(noSandbox("bash -c 'eval kill 1'")).toBe(true);
    });

    test("bash -c '. ./evil.sh' → blocked (dot-source)", () => {
        expect(noSandbox("bash -c '. ./evil.sh'")).toBe(true);
    });

    test("bash -c 'source ./evil.sh' → blocked", () => {
        expect(noSandbox("bash -c 'source ./evil.sh'")).toBe(true);
    });

    // eval is blocked unconditionally — we cannot statically analyse what it will run
    test("bash -c 'eval echo hello' → blocked (eval always blocked)", () => {
        expect(noSandbox("bash -c 'eval echo hello'")).toBe(true);
    });
});

describe("dangerous builtins in -c strings — sandbox active", () => {
    test("bash -c 'eval git push' → blocked (sandbox)", () => {
        expect(withSandbox("bash -c 'eval git push'")).toBe(true);
    });

    test("bash -c 'eval kill 1' → blocked (sandbox)", () => {
        expect(withSandbox("bash -c 'eval kill 1'")).toBe(true);
    });

    test("bash -c '. ./evil.sh' → blocked (sandbox: dot-source)", () => {
        expect(withSandbox("bash -c '. ./evil.sh'")).toBe(true);
    });

    test("bash -c 'source ./evil.sh' → blocked (sandbox)", () => {
        expect(withSandbox("bash -c 'source ./evil.sh'")).toBe(true);
    });
});

describe("regression — destructive commands still blocked", () => {
    test("rm -rf / → blocked", () => expect(noSandbox("rm -rf /")).toBe(true));
    test("git push → blocked (no-sandbox)", () => expect(noSandbox("git push")).toBe(true));
    test("sudo apt install foo → blocked", () => expect(noSandbox("sudo apt install foo")).toBe(true));
    test("kill 1 → blocked (no-sandbox)", () => expect(noSandbox("kill 1")).toBe(true));
    test("kill 1 → blocked (sandbox)", () => expect(withSandbox("kill 1")).toBe(true));
    test("git push → blocked (sandbox)", () => expect(withSandbox("git push")).toBe(true));
});
