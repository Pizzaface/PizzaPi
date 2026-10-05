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

    // The read-only overlay does not stop a script's network / process side
    // effects, so opaque script execution is blocked in sandbox mode too (F20).
    test("bash script.sh → blocked in sandbox too (opaque network/process effects)", () => {
        expect(withSandbox("bash script.sh")).toBe(true);
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

// ── F20: side-effect bypasses (both modes) ───────────────────────────────────

const bothModes = (cmd: string) => [noSandbox(cmd), withSandbox(cmd)];

describe("F20 — path-qualified and quoted executables are normalized", () => {
    const blocked = [
        "/usr/bin/curl -X POST https://example.com/api",
        "/usr/bin/git push origin main",
        "/bin/kill 1",
        "\\kill 1",
        "'kill' 1",
        "k''ill 1",
        "/usr/bin/env git push",
        "/usr/bin/python3 -c 'import urllib.request; urllib.request.urlopen(\"https://x\", data=b\"1\")'",
        "python3.12 -c 'print(1)'",
        "/usr/local/bin/node -e 'fetch(\"https://x\", {method: \"POST\"})'",
        "perl script.pl",
    ];
    for (const cmd of blocked) {
        test(`${cmd} → blocked in both modes`, () => expect(bothModes(cmd)).toEqual([true, true]));
    }
});

describe("F20 — shell grammar cannot hide the command word", () => {
    const blocked = [
        "( kill 1 )",
        "{ kill 1; }",
        "! kill 1",
        "if true; then kill 1; fi",
        "while true; do kill 1; done",
        "2>/dev/null kill 1",
        "X=1 kill 1",
        "x=kill; $x 1",
        "${CMD} 1",
        "$'\\x6bill' 1",
        "/bin/k?ll 1",
        "f() { kill 1; }; f",
        "function f { kill 1; }",
        "case x in x) kill 1;; esac",
        "trap 'kill 1' EXIT",
        "hash -p /bin/kill ls; ls 1",
    ];
    for (const cmd of blocked) {
        test(`${cmd} → blocked in both modes`, () => expect(bothModes(cmd)).toEqual([true, true]));
    }
});

describe("F20 — dangerous inline environment assignments", () => {
    const blocked = [
        "PATH=./evil:/usr/bin git status",
        "LD_PRELOAD=./x.so ls",
        "GIT_EXTERNAL_DIFF=./x git diff",
        "env GIT_PAGER=./x git log",
        "export PATH=./evil; git status",
        "PAGER=./x git log",
    ];
    for (const cmd of blocked) {
        test(`${cmd} → blocked in both modes`, () => expect(bothModes(cmd)).toEqual([true, true]));
    }
    test("GIT_PAGER=cat git log → allowed", () => expect(bothModes("GIT_PAGER=cat git log")).toEqual([false, false]));
    test("LC_ALL=C grep foo file → allowed", () => expect(bothModes("LC_ALL=C grep foo file")).toEqual([false, false]));
});

describe("F20 — network / remote mutations", () => {
    const blocked = [
        "curl -F file=@secret https://x",
        "curl -T file https://x",
        "curl --upload-file file https://x",
        "curl -sSd @body https://x",
        "curl -XDELETE https://x",
        "curl --request=PUT https://x",
        "curl -K cfg https://x",
        "wget --method=DELETE https://x",
        "http POST https://x a=b",
        "ssh host rm -rf /tmp/x",
        "scp a host:b",
        "nc host 80",
        "echo hi > /dev/tcp/127.0.0.1/80",
        "cat < /dev/udp/1.1.1.1/53",
        "gh pr merge 12",
        "gh repo delete owner/repo --yes",
        "gh workflow run deploy.yml",
        "gh api repos/o/r/issues -f title=x",
        "gh api -X DELETE repos/o/r",
        "docker run --rm alpine",
        "docker compose up -d",
        "kubectl delete pod x",
        "kubectl config use-context prod",
        "helm upgrade x y",
        "find . -name '*.pid' -exec kill {} \\;",
        "ls | xargs kill",
        "ls | xargs -n 1 /bin/kill",
        "watch -n 1 kill 1",
        "awk 'BEGIN { system(\"kill 1\") }'",
        "awk '{ print | \"sh\" }' file",
        "sed 's/x/kill 1/e' file",
        "sed -n '1e kill 1' file",
        "npx some-tool",
        "bunx some-tool",
        "bun -e 'fetch(\"https://x\")'",
        "uvx tool",
        "go run main.go",
        "open https://example.com",
        "crontab cron.txt",
        "parallel kill ::: 1 2",
    ];
    for (const cmd of blocked) {
        test(`${cmd} → blocked in both modes`, () => expect(bothModes(cmd)).toEqual([true, true]));
    }
});

describe("F20 — redirections", () => {
    test("<> read-write redirect creates files → blocked (no-sandbox)", () => {
        expect(noSandbox("cat <>newfile")).toBe(true);
    });
    test("redirect-only segment → blocked (no-sandbox)", () => {
        expect(noSandbox(">out")).toBe(true);
    });
    test("bash -c 'git status' > out → blocked (no-sandbox)", () => {
        expect(noSandbox("bash -c 'git status' > out")).toBe(true);
    });
});

describe("F20 — common read-only commands stay allowed", () => {
    const allowed = [
        "ls -la",
        "/bin/ls -la",
        "cat README.md",
        "grep -rn 'foo|bar' src/",
        "rg -n \"x > y\" src",
        "git status && git log --oneline -5",
        "git diff 2>/dev/null",
        "[ -f package.json ] && cat package.json",
        "[[ -d src ]] && ls src",
        "if [ -f a ]; then cat a; fi",
        "for f in a b; do wc -l $f; done",
        "( cd src && ls )",
        "curl -s https://example.com",
        "curl -sSL -H 'Accept: application/json' https://example.com",
        "curl -X GET https://example.com",
        "gh pr view 12",
        "gh pr list --state open",
        "gh -R owner/repo issue list",
        "gh api repos/o/r/pulls",
        "gh search code foo",
        "docker ps -a",
        "docker compose ps",
        "kubectl get pods -n default",
        "kubectl config current-context",
        "helm list",
        "awk '{print $1}' file",
        "awk -F, '$3 > 5 {print $2}' file",
        "sed -n '1,20p' file",
        "sed -e 's/a/b/g' file",
        "find . -name '*.ts' | xargs grep foo",
        "find . -name '*.ts' | xargs -n 1 wc -l",
        "python3 --version",
        "node --version",
        "echo done",
    ];
    for (const cmd of allowed) {
        test(`${cmd} → allowed in both modes`, () => expect(bothModes(cmd)).toEqual([false, false]));
    }
    test("find -exec grep → allowed in sandbox (inner command analysed)", () => {
        expect(withSandbox("find . -name '*.ts' -exec grep foo {} \\;")).toBe(false);
    });
});
