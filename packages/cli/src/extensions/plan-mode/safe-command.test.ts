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

    test("bash without -c → allowed (no inline code execution)", () => {
        expect(noSandbox("bash script.sh")).toBe(false);
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

describe("regression — destructive commands still blocked", () => {
    test("rm -rf / → blocked", () => expect(noSandbox("rm -rf /")).toBe(true));
    test("git push → blocked (no-sandbox)", () => expect(noSandbox("git push")).toBe(true));
    test("sudo apt install foo → blocked", () => expect(noSandbox("sudo apt install foo")).toBe(true));
    test("kill 1 → blocked (no-sandbox)", () => expect(noSandbox("kill 1")).toBe(true));
    test("kill 1 → blocked (sandbox)", () => expect(withSandbox("kill 1")).toBe(true));
    test("git push → blocked (sandbox)", () => expect(withSandbox("git push")).toBe(true));
});
