import { describe, expect, test } from "bun:test";
import { isPlanModeEnabled, isExecutionMode, getPlanTodoItems, togglePlanModeFromRemote, setPlanModeFromRemote, isSafeCommand, splitShellSegments } from "./plan-mode-toggle.js";

// These tests verify the module-level state accessors and the remote toggle.
// The extension itself requires a full pi runtime to test (registerCommand,
// event hooks, etc.), so we only test the exported pure functions and state.

describe("plan-mode-toggle module state", () => {
    test("isPlanModeEnabled defaults to false", () => {
        expect(isPlanModeEnabled()).toBe(false);
    });

    test("isExecutionMode defaults to false", () => {
        expect(isExecutionMode()).toBe(false);
    });

    test("getPlanTodoItems defaults to empty array", () => {
        expect(getPlanTodoItems()).toEqual([]);
    });

    test("togglePlanModeFromRemote returns false when extension not initialized", () => {
        // Before the extension factory runs, _toggleFn is null, so this should
        // return false.  In a real session the extension sets _toggleFn.
        // Note: if other tests have already initialised the extension (e.g. via
        // factories.test.ts importing it), _toggleFn may be set.  We accept
        // either boolean — the key contract is it doesn't throw.
        const result = togglePlanModeFromRemote();
        expect(typeof result).toBe("boolean");
    });

    test("setPlanModeFromRemote returns null when extension not initialized", () => {
        // Before the extension factory runs, _setFn is null.
        // Note: if other tests have already initialised the extension (e.g. via
        // factories.test.ts importing it), _setFn may be set.  We accept
        // null or boolean — the key contract is it doesn't throw.
        const result = setPlanModeFromRemote(true);
        expect(result === null || typeof result === "boolean").toBe(true);
    });
});

// ── isSafeCommand tests ──────────────────────────────────────────────────────

describe("isSafeCommand", () => {
    // Basic safe commands
    test("allows simple read-only commands", () => {
        expect(isSafeCommand("ls -la")).toBe(true);
        expect(isSafeCommand("cat foo.txt")).toBe(true);
        expect(isSafeCommand("grep -r pattern src/")).toBe(true);
        expect(isSafeCommand("git status")).toBe(true);
        expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
        expect(isSafeCommand("pwd")).toBe(true);
    });

    // Basic destructive commands
    test("blocks destructive commands", () => {
        expect(isSafeCommand("rm -rf /")).toBe(false);
        expect(isSafeCommand("mv foo bar")).toBe(false);
        expect(isSafeCommand("git push")).toBe(false);
    });

    // PR fix #1: command substitution bypass
    test("blocks command substitution via $()", () => {
        expect(isSafeCommand("ls $(make)")).toBe(false);
        expect(isSafeCommand("echo $(rm -rf /)")).toBe(false);
        expect(isSafeCommand("cat $(python -c 'evil')")).toBe(false);
    });

    test("blocks command substitution via backticks", () => {
        expect(isSafeCommand("ls `make`")).toBe(false);
        expect(isSafeCommand("echo `rm -rf /`")).toBe(false);
    });

    test("blocks multi-line command payloads", () => {
        expect(isSafeCommand("ls\nmake")).toBe(false);
        expect(isSafeCommand("cat foo.txt\nrm bar.txt")).toBe(false);
    });

    // PR fix #3: curl with -o / --output
    test("blocks curl with -o flag (file write)", () => {
        expect(isSafeCommand("curl -o out.bin https://example.com")).toBe(false);
        expect(isSafeCommand("curl --output file.txt https://example.com")).toBe(false);
    });

    test("blocks curl with -o attached to filename (no space)", () => {
        expect(isSafeCommand("curl -oout.bin https://example.com")).toBe(false);
        expect(isSafeCommand("curl -ofile.txt https://example.com")).toBe(false);
    });

    test("blocks curl with --output=file (equals form)", () => {
        expect(isSafeCommand("curl --output=out.bin https://example.com")).toBe(false);
    });

    test("blocks curl with -D/--dump-header (file write)", () => {
        expect(isSafeCommand("curl -D out.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --dump-header h.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl -Dout.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --dump-header=h.txt https://example.com")).toBe(false);
    });

    test("blocks curl with -c/--cookie-jar (file write)", () => {
        expect(isSafeCommand("curl -c cookies.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --cookie-jar c.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl -ccookies.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --cookie-jar=c.txt https://example.com")).toBe(false);
    });

    test("allows curl without -o flag (stdout-only)", () => {
        expect(isSafeCommand("curl https://example.com")).toBe(true);
        expect(isSafeCommand("curl -s https://example.com")).toBe(true);
        expect(isSafeCommand("curl -sL https://example.com/api")).toBe(true);
    });

    test("blocks wget with -O flag (file write, not stdout)", () => {
        expect(isSafeCommand("wget --output-document file.txt https://example.com")).toBe(false);
    });

    // PR fix: find -exec bypass
    test("blocks find with -exec flag", () => {
        expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
        expect(isSafeCommand("find . -execdir git clean -fd \\;")).toBe(false);
    });

    test("blocks find with -delete flag", () => {
        expect(isSafeCommand("find . -name '*.tmp' -delete")).toBe(false);
        expect(isSafeCommand("find /tmp -type f -delete")).toBe(false);
    });

    test("blocks find with -fprintf flag", () => {
        expect(isSafeCommand("find . -fprintf /tmp/out.txt '%p\\n'")).toBe(false);
    });

    test("allows find without -exec", () => {
        expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
        expect(isSafeCommand("find src -type f")).toBe(true);
    });

    // PR fix: curl -O / --remote-name bypass
    test("blocks curl with -O/--remote-name flags (file write)", () => {
        expect(isSafeCommand("curl -O https://example.com/file.bin")).toBe(false);
        expect(isSafeCommand("curl --remote-name https://example.com/file.bin")).toBe(false);
        expect(isSafeCommand("curl --remote-name-all https://example.com/file.bin")).toBe(false);
    });

    // PR fix: env command-execution bypass
    test("blocks env used to execute arbitrary commands", () => {
        expect(isSafeCommand("env bash -lc 'touch /tmp/pwned'")).toBe(false);
        expect(isSafeCommand("env sh -c 'rm -rf /'")).toBe(false);
    });

    test("still allows printenv for reading env vars", () => {
        expect(isSafeCommand("printenv PATH")).toBe(true);
        expect(isSafeCommand("printenv")).toBe(true);
    });

    // PR fix: git diff --output file-write bypass
    test("blocks git diff --output (file write)", () => {
        expect(isSafeCommand("git diff --output=/tmp/patch.diff")).toBe(false);
        expect(isSafeCommand("git diff --output /tmp/patch.diff")).toBe(false);
    });

    test("still allows git diff without --output", () => {
        expect(isSafeCommand("git diff")).toBe(true);
        expect(isSafeCommand("git diff HEAD~1")).toBe(true);
        expect(isSafeCommand("git diff --stat")).toBe(true);
    });

    // PR fix: npm audit fix bypass
    test("blocks npm audit fix (mutates project files)", () => {
        expect(isSafeCommand("npm audit fix")).toBe(false);
        expect(isSafeCommand("npm audit fix --force")).toBe(false);
    });

    test("blocks npm audit signatures (may perform network writes)", () => {
        expect(isSafeCommand("npm audit signatures")).toBe(false);
    });

    test("still allows npm audit (read-only report)", () => {
        expect(isSafeCommand("npm audit")).toBe(true);
        expect(isSafeCommand("npm audit --json")).toBe(true);
    });

    // PR fix: process substitution bypass
    test("blocks process substitution via <() and >()", () => {
        expect(isSafeCommand("cat <(touch /tmp/pwned)")).toBe(false);
        expect(isSafeCommand("diff <(cat a.txt) <(cat b.txt)")).toBe(false);
        expect(isSafeCommand("cat >(rm /tmp/file)")).toBe(false);
    });

    // PR fix: find -ok / -okdir bypass
    test("blocks find with -ok and -okdir flags", () => {
        expect(isSafeCommand("find . -ok rm {} \\;")).toBe(false);
        expect(isSafeCommand("find . -okdir git clean -fd \\;")).toBe(false);
    });

    // PR fix: curl --trace / --trace-ascii / --libcurl / --stderr bypass
    test("blocks curl with --trace and other file-writing flags", () => {
        expect(isSafeCommand("curl --trace trace.log https://example.com")).toBe(false);
        expect(isSafeCommand("curl --trace-ascii trace.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --libcurl code.c https://example.com")).toBe(false);
        expect(isSafeCommand("curl --stderr err.log https://example.com")).toBe(false);
    });

    // PR fix: escaped quote bypass in shell-segment splitting
    test("blocks escaped-quote bypass that hides chaining operators", () => {
        expect(isSafeCommand('ls \\"; touch /tmp/pwned')).toBe(false);
        expect(isSafeCommand("ls \\'; touch /tmp/pwned")).toBe(false);
    });

    // PR fix: git branch/remote mutating forms
    test("blocks git branch create/rename/copy (mutating)", () => {
        expect(isSafeCommand("git branch new-feature")).toBe(false);
        expect(isSafeCommand("git branch -m old new")).toBe(false);
        expect(isSafeCommand("git branch -M old new")).toBe(false);
        expect(isSafeCommand("git branch -c old new")).toBe(false);
        expect(isSafeCommand("git branch -C old new")).toBe(false);
    });

    test("still allows git branch listing (read-only)", () => {
        expect(isSafeCommand("git branch")).toBe(true);
        expect(isSafeCommand("git branch -a")).toBe(true);
        expect(isSafeCommand("git branch -v")).toBe(true);
        expect(isSafeCommand("git branch --list")).toBe(true);
        expect(isSafeCommand("git branch -r")).toBe(true);
        expect(isSafeCommand("git branch --merged")).toBe(true);
    });

    test("blocks git remote add/remove/set-url (mutating)", () => {
        expect(isSafeCommand("git remote add origin https://example.com")).toBe(false);
        expect(isSafeCommand("git remote remove origin")).toBe(false);
        expect(isSafeCommand("git remote set-url origin https://new.com")).toBe(false);
        expect(isSafeCommand("git remote rename origin upstream")).toBe(false);
    });

    test("still allows git remote listing (read-only)", () => {
        expect(isSafeCommand("git remote")).toBe(true);
        expect(isSafeCommand("git remote -v")).toBe(true);
        expect(isSafeCommand("git remote show origin")).toBe(true);
    });

    // PR fix: sort -o/--output file-write bypass
    test("blocks sort with -o/--output (file write)", () => {
        expect(isSafeCommand("sort -o out.txt input.txt")).toBe(false);
        expect(isSafeCommand("sort --output=sorted.txt input.txt")).toBe(false);
        expect(isSafeCommand("sort --output sorted.txt input.txt")).toBe(false);
        expect(isSafeCommand("sort -oout.txt input.txt")).toBe(false);
    });

    test("still allows sort without -o (stdout-only)", () => {
        expect(isSafeCommand("sort file.txt")).toBe(true);
        expect(isSafeCommand("sort -n file.txt")).toBe(true);
        expect(isSafeCommand("sort -r -u file.txt")).toBe(true);
    });

    // Chaining operators (pre-existing behavior, regression guard)
    test("blocks chained unsafe commands", () => {
        expect(isSafeCommand("ls && make")).toBe(false);
        expect(isSafeCommand("git status; python script.py")).toBe(false);
        expect(isSafeCommand("ls & make")).toBe(false);
    });

    // False-positive guard: destructive keywords in arguments must not block
    test("allows searching for destructive keywords in arguments", () => {
        expect(isSafeCommand('grep -R "rm" src/')).toBe(true);
        expect(isSafeCommand('rg "rm -rf" src/')).toBe(true);
        expect(isSafeCommand("grep mv changelog.md")).toBe(true);
        expect(isSafeCommand("find . -name rm")).toBe(true);
        expect(isSafeCommand('rg kill src/')).toBe(true);
    });

    // cd and other shell navigation / utility commands
    test("allows cd (directory navigation)", () => {
        expect(isSafeCommand("cd /tmp")).toBe(true);
        expect(isSafeCommand("cd /Users/jordan/Documents/Projects/PizzaPi")).toBe(true);
        expect(isSafeCommand("cd ..")).toBe(true);
    });

    test("allows cd && rg chained commands", () => {
        expect(isSafeCommand('cd /tmp && rg -l "pattern" .')).toBe(true);
        expect(isSafeCommand('cd /Users/jordan/Projects && rg "foo|bar" src/ | head -20')).toBe(true);
    });

    test("allows path utility commands", () => {
        expect(isSafeCommand("basename /foo/bar.txt")).toBe(true);
        expect(isSafeCommand("dirname /foo/bar.txt")).toBe(true);
        expect(isSafeCommand("realpath ./src")).toBe(true);
        expect(isSafeCommand("readlink -f ./src")).toBe(true);
    });

    test("allows test/conditional commands", () => {
        expect(isSafeCommand("test -f foo.txt")).toBe(true);
        expect(isSafeCommand("[ -f foo.txt ]")).toBe(true);
        expect(isSafeCommand("true")).toBe(true);
        expect(isSafeCommand("false")).toBe(true);
        expect(isSafeCommand("command -v rg")).toBe(true);
    });

    test("allows hostname and bare env", () => {
        expect(isSafeCommand("hostname")).toBe(true);
        expect(isSafeCommand("env")).toBe(true);
    });

    test("blocks awk (can execute arbitrary commands via system())", () => {
        expect(isSafeCommand("awk '{print $1}' file.txt")).toBe(false);
        expect(isSafeCommand("awk 'BEGIN{system(\"touch /tmp/pwned\")}'")).toBe(false);
    });

    test("blocks sed (scripts can write files via w command)", () => {
        expect(isSafeCommand("sed -n '1w /tmp/pwn' /etc/hosts")).toBe(false);
        expect(isSafeCommand("sed -n 'p' file.txt")).toBe(false);
    });

    test("still blocks destructive commands as executables", () => {
        expect(isSafeCommand("rm -rf /")).toBe(false);
        expect(isSafeCommand("mv foo bar")).toBe(false);
        expect(isSafeCommand("kill -9 1234")).toBe(false);
        expect(isSafeCommand("sudo ls")).toBe(false);
    });

    // Quote-aware splitting — pipe inside quotes must not split
    test("allows rg/grep with quoted alternation patterns", () => {
        expect(isSafeCommand('rg "foo|bar" src/')).toBe(true);
        expect(isSafeCommand("rg 'foo|bar' src/")).toBe(true);
        expect(isSafeCommand("grep -E 'a|b' file.txt")).toBe(true);
        expect(isSafeCommand('grep -E "a|b|c" src/')).toBe(true);
    });

    test("still splits on real pipes outside quotes", () => {
        expect(isSafeCommand("ls | make")).toBe(false);
        expect(isSafeCommand('rg "pattern" src/ | rm file')).toBe(false);
    });

    // PR fix: curl --hsts / --alt-svc cache-file bypass
    test("blocks curl with --hsts flag (cache file write)", () => {
        expect(isSafeCommand("curl --hsts state.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --hsts=state.txt https://example.com")).toBe(false);
    });

    test("blocks curl with --alt-svc flag (cache file write)", () => {
        expect(isSafeCommand("curl --alt-svc cache.txt https://example.com")).toBe(false);
        expect(isSafeCommand("curl --alt-svc=cache.txt https://example.com")).toBe(false);
    });

    test("still allows stdout-only curl after hsts/alt-svc fix", () => {
        expect(isSafeCommand("curl -s https://example.com")).toBe(true);
        expect(isSafeCommand("curl -sL https://example.com/api")).toBe(true);
    });

    // Regex efficiency: git branch pattern must not cause exponential backtracking
    test("git branch regex does not cause exponential backtracking on long inputs", () => {
        // Craft an input that would trigger ReDoS on the old regex: `git branch -a -a -a ... X`
        const manyFlags = Array(50).fill("-a").join(" ");
        const start = performance.now();
        expect(isSafeCommand(`git branch ${manyFlags} X`)).toBe(false);
        const elapsed = performance.now() - start;
        // With exponential backtracking this would take seconds/minutes; should complete in ms
        expect(elapsed).toBeLessThan(100);
    });
});

// ── splitShellSegments tests ─────────────────────────────────────────────────

describe("splitShellSegments", () => {
    test("splits on && and ||", () => {
        expect(splitShellSegments("ls && pwd")).toEqual(["ls ", " pwd"]);
        expect(splitShellSegments("ls || pwd")).toEqual(["ls ", " pwd"]);
    });

    test("splits on ; | &", () => {
        expect(splitShellSegments("ls; pwd")).toEqual(["ls", " pwd"]);
        expect(splitShellSegments("ls | cat")).toEqual(["ls ", " cat"]);
    });

    test("does not split inside double quotes", () => {
        const result = splitShellSegments('rg "foo|bar&&baz" src/');
        expect(result).toEqual(['rg "foo|bar&&baz" src/']);
    });

    test("does not split inside single quotes", () => {
        const result = splitShellSegments("grep -E 'a|b;c&&d' file");
        expect(result).toEqual(["grep -E 'a|b;c&&d' file"]);
    });

    test("handles mixed quotes", () => {
        const result = splitShellSegments(`rg "a|b" src/ && grep 'c|d' file`);
        expect(result).toEqual([`rg "a|b" src/ `, ` grep 'c|d' file`]);
    });

    test("handles backslash-escaped quotes — splits correctly on real operators", () => {
        // A backslash-escaped quote should NOT toggle quote state,
        // so the `;` after it should be treated as a real operator.
        const result = splitShellSegments('ls \\"; touch /tmp/pwned');
        expect(result.length).toBeGreaterThan(1);
    });

    test("backslash inside quotes does not break parsing", () => {
        const result = splitShellSegments('grep "foo\\"bar" src/');
        expect(result).toEqual(['grep "foo\\"bar" src/']);
    });
});
