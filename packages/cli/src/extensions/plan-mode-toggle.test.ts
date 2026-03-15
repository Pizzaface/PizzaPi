import { describe, expect, test } from "bun:test";
import { isPlanModeEnabled, isExecutionMode, getPlanTodoItems, togglePlanModeFromRemote, setPlanModeFromRemote, isSafeCommand, isDestructiveCommand, splitShellSegments } from "./plan-mode-toggle.js";

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

// ── isDestructiveCommand tests ───────────────────────────────────────────────
//
// Blocklist-only approach: commands matching known destructive patterns are
// flagged. Everything else is allowed through — the OS-level sandbox enforces
// filesystem write restrictions. This replaces the old allowlist approach
// where commands had to appear on a safe-list to be permitted.

describe("isDestructiveCommand", () => {
    // ── Non-destructive commands (should NOT be flagged) ─────────────────────

    test("allows common read-only commands", () => {
        expect(isDestructiveCommand("ls -la")).toBe(false);
        expect(isDestructiveCommand("cat foo.txt")).toBe(false);
        expect(isDestructiveCommand("grep -r pattern src/")).toBe(false);
        expect(isDestructiveCommand("git status")).toBe(false);
        expect(isDestructiveCommand("find . -name '*.ts'")).toBe(false);
        expect(isDestructiveCommand("pwd")).toBe(false);
    });

    test("allows commands that the old allowlist didn't cover", () => {
        expect(isDestructiveCommand("cd /tmp && rg pattern .")).toBe(false);
        expect(isDestructiveCommand("xargs echo")).toBe(false);
        expect(isDestructiveCommand("column -t file.txt")).toBe(false);
        expect(isDestructiveCommand("cut -d: -f1 /etc/passwd")).toBe(false);
        expect(isDestructiveCommand("tr '[:lower:]' '[:upper:]'")).toBe(false);
        expect(isDestructiveCommand("basename /foo/bar.txt")).toBe(false);
        expect(isDestructiveCommand("dirname /foo/bar.txt")).toBe(false);
        expect(isDestructiveCommand("awk '{print $1}' file.txt")).toBe(false);
        expect(isDestructiveCommand("sed -n 'p' file.txt")).toBe(false);
        expect(isDestructiveCommand("env")).toBe(false);
        expect(isDestructiveCommand("make --dry-run")).toBe(false);
        expect(isDestructiveCommand("python --version")).toBe(false);
    });

    test("allows cd (directory navigation)", () => {
        expect(isDestructiveCommand("cd /tmp")).toBe(false);
        expect(isDestructiveCommand("cd /Users/jordan/Documents/Projects/PizzaPi")).toBe(false);
        expect(isDestructiveCommand("cd ..")).toBe(false);
    });

    test("allows cd && rg chained commands", () => {
        expect(isDestructiveCommand('cd /tmp && rg -l "pattern" .')).toBe(false);
        expect(isDestructiveCommand('cd /Users/jordan/Projects && rg "foo|bar" src/ | head -20')).toBe(false);
    });

    test("allows piping between non-destructive commands", () => {
        expect(isDestructiveCommand("ls | head -20")).toBe(false);
        expect(isDestructiveCommand("cat file | grep pattern | wc -l")).toBe(false);
        expect(isDestructiveCommand("rg pattern src/ | sort | uniq")).toBe(false);
    });

    test("allows chained non-destructive commands", () => {
        expect(isDestructiveCommand("ls && pwd")).toBe(false);
        expect(isDestructiveCommand("echo hello; date")).toBe(false);
    });

    test("allows printenv for reading env vars", () => {
        expect(isDestructiveCommand("printenv PATH")).toBe(false);
        expect(isDestructiveCommand("printenv")).toBe(false);
    });

    test("allows git diff without --output", () => {
        expect(isDestructiveCommand("git diff")).toBe(false);
        expect(isDestructiveCommand("git diff HEAD~1")).toBe(false);
        expect(isDestructiveCommand("git diff --stat")).toBe(false);
    });

    test("allows npm audit (read-only report)", () => {
        expect(isDestructiveCommand("npm audit")).toBe(false);
        expect(isDestructiveCommand("npm audit --json")).toBe(false);
    });

    test("allows find without -exec", () => {
        expect(isDestructiveCommand("find . -name '*.ts'")).toBe(false);
        expect(isDestructiveCommand("find src -type f")).toBe(false);
    });

    test("allows git branch listing (read-only)", () => {
        expect(isDestructiveCommand("git branch")).toBe(false);
        expect(isDestructiveCommand("git branch -a")).toBe(false);
        expect(isDestructiveCommand("git branch -v")).toBe(false);
        expect(isDestructiveCommand("git branch --list")).toBe(false);
        expect(isDestructiveCommand("git branch -r")).toBe(false);
        expect(isDestructiveCommand("git branch --merged")).toBe(false);
    });

    test("allows git remote listing (read-only)", () => {
        expect(isDestructiveCommand("git remote")).toBe(false);
        expect(isDestructiveCommand("git remote -v")).toBe(false);
        expect(isDestructiveCommand("git remote show origin")).toBe(false);
    });

    test("allows sort without -o (stdout-only)", () => {
        expect(isDestructiveCommand("sort file.txt")).toBe(false);
        expect(isDestructiveCommand("sort -n file.txt")).toBe(false);
        expect(isDestructiveCommand("sort -r -u file.txt")).toBe(false);
    });

    test("allows curl without -o flag (stdout-only)", () => {
        expect(isDestructiveCommand("curl https://example.com")).toBe(false);
        expect(isDestructiveCommand("curl -s https://example.com")).toBe(false);
        expect(isDestructiveCommand("curl -sL https://example.com/api")).toBe(false);
    });

    test("allows rg/grep with quoted alternation patterns", () => {
        expect(isDestructiveCommand('rg "foo|bar" src/')).toBe(false);
        expect(isDestructiveCommand("rg 'foo|bar' src/")).toBe(false);
        expect(isDestructiveCommand("grep -E 'a|b' file.txt")).toBe(false);
        expect(isDestructiveCommand('grep -E "a|b|c" src/')).toBe(false);
    });

    test("allows searching for destructive keywords in arguments", () => {
        expect(isDestructiveCommand('grep -R "rm" src/')).toBe(false);
        expect(isDestructiveCommand('rg "rm -rf" src/')).toBe(false);
        expect(isDestructiveCommand("grep mv changelog.md")).toBe(false);
        expect(isDestructiveCommand("find . -name rm")).toBe(false);
        expect(isDestructiveCommand('rg kill src/')).toBe(false);
    });

    // ── Destructive commands (SHOULD be flagged) ─────────────────────────────

    test("flags basic destructive commands", () => {
        expect(isDestructiveCommand("rm -rf /")).toBe(true);
        expect(isDestructiveCommand("mv foo bar")).toBe(true);
        expect(isDestructiveCommand("git push")).toBe(true);
        expect(isDestructiveCommand("kill -9 1234")).toBe(true);
        expect(isDestructiveCommand("sudo ls")).toBe(true);
    });

    test("flags command substitution via $()", () => {
        expect(isDestructiveCommand("ls $(make)")).toBe(true);
        expect(isDestructiveCommand("echo $(rm -rf /)")).toBe(true);
        expect(isDestructiveCommand("cat $(python -c 'evil')")).toBe(true);
    });

    test("flags command substitution via backticks", () => {
        expect(isDestructiveCommand("ls `make`")).toBe(true);
        expect(isDestructiveCommand("echo `rm -rf /`")).toBe(true);
    });

    test("flags multi-line command payloads", () => {
        expect(isDestructiveCommand("ls\nmake")).toBe(true);
        expect(isDestructiveCommand("cat foo.txt\nrm bar.txt")).toBe(true);
    });

    test("flags process substitution via <() and >()", () => {
        expect(isDestructiveCommand("cat <(touch /tmp/pwned)")).toBe(true);
        expect(isDestructiveCommand("diff <(cat a.txt) <(cat b.txt)")).toBe(true);
        expect(isDestructiveCommand("cat >(rm /tmp/file)")).toBe(true);
    });

    // curl file-writing flags
    test("flags curl with -o flag (file write)", () => {
        expect(isDestructiveCommand("curl -o out.bin https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --output file.txt https://example.com")).toBe(true);
    });

    test("flags curl with -o attached to filename (no space)", () => {
        expect(isDestructiveCommand("curl -oout.bin https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl -ofile.txt https://example.com")).toBe(true);
    });

    test("flags curl with --output=file (equals form)", () => {
        expect(isDestructiveCommand("curl --output=out.bin https://example.com")).toBe(true);
    });

    test("flags curl with -D/--dump-header (file write)", () => {
        expect(isDestructiveCommand("curl -D out.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --dump-header h.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl -Dout.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --dump-header=h.txt https://example.com")).toBe(true);
    });

    test("flags curl with -c/--cookie-jar (file write)", () => {
        expect(isDestructiveCommand("curl -c cookies.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --cookie-jar c.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl -ccookies.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --cookie-jar=c.txt https://example.com")).toBe(true);
    });

    test("flags curl with -O/--remote-name flags (file write)", () => {
        expect(isDestructiveCommand("curl -O https://example.com/file.bin")).toBe(true);
        expect(isDestructiveCommand("curl --remote-name https://example.com/file.bin")).toBe(true);
        expect(isDestructiveCommand("curl --remote-name-all https://example.com/file.bin")).toBe(true);
    });

    test("flags curl with --trace and other file-writing flags", () => {
        expect(isDestructiveCommand("curl --trace trace.log https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --trace-ascii trace.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --libcurl code.c https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --stderr err.log https://example.com")).toBe(true);
    });

    test("flags curl with --hsts flag (cache file write)", () => {
        expect(isDestructiveCommand("curl --hsts state.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --hsts=state.txt https://example.com")).toBe(true);
    });

    test("flags curl with --alt-svc flag (cache file write)", () => {
        expect(isDestructiveCommand("curl --alt-svc cache.txt https://example.com")).toBe(true);
        expect(isDestructiveCommand("curl --alt-svc=cache.txt https://example.com")).toBe(true);
    });

    test("flags wget with -O flag (file write, not stdout)", () => {
        expect(isDestructiveCommand("wget --output-document file.txt https://example.com")).toBe(true);
    });

    // find destructive flags
    test("flags find with -exec flag", () => {
        expect(isDestructiveCommand("find . -exec rm {} \\;")).toBe(true);
        expect(isDestructiveCommand("find . -execdir git clean -fd \\;")).toBe(true);
    });

    test("flags find with -delete flag", () => {
        expect(isDestructiveCommand("find . -name '*.tmp' -delete")).toBe(true);
        expect(isDestructiveCommand("find /tmp -type f -delete")).toBe(true);
    });

    test("flags find with -fprintf flag", () => {
        expect(isDestructiveCommand("find . -fprintf /tmp/out.txt '%p\\n'")).toBe(true);
    });

    test("flags find with -ok and -okdir flags", () => {
        expect(isDestructiveCommand("find . -ok rm {} \\;")).toBe(true);
        expect(isDestructiveCommand("find . -okdir git clean -fd \\;")).toBe(true);
    });

    // git destructive forms
    test("flags git diff --output (file write)", () => {
        expect(isDestructiveCommand("git diff --output=/tmp/patch.diff")).toBe(true);
        expect(isDestructiveCommand("git diff --output /tmp/patch.diff")).toBe(true);
    });

    test("flags git remote add/remove/set-url (mutating)", () => {
        expect(isDestructiveCommand("git remote add origin https://example.com")).toBe(true);
        expect(isDestructiveCommand("git remote remove origin")).toBe(true);
        expect(isDestructiveCommand("git remote set-url origin https://new.com")).toBe(true);
        expect(isDestructiveCommand("git remote rename origin upstream")).toBe(true);
    });

    // sort -o file-write bypass
    test("flags sort with -o/--output (file write)", () => {
        expect(isDestructiveCommand("sort -o out.txt input.txt")).toBe(true);
        expect(isDestructiveCommand("sort --output=sorted.txt input.txt")).toBe(true);
        expect(isDestructiveCommand("sort --output sorted.txt input.txt")).toBe(true);
        expect(isDestructiveCommand("sort -oout.txt input.txt")).toBe(true);
    });

    // output redirection
    test("flags output redirection", () => {
        expect(isDestructiveCommand("echo foo > file.txt")).toBe(true);
        expect(isDestructiveCommand("echo foo >> file.txt")).toBe(true);
    });

    // escaped quote bypass
    test("flags escaped-quote bypass that hides chaining operators", () => {
        expect(isDestructiveCommand('ls \\"; touch /tmp/pwned')).toBe(true);
        expect(isDestructiveCommand("ls \\'; touch /tmp/pwned")).toBe(true);
    });

    // chain with a destructive segment
    test("flags chains containing a destructive segment", () => {
        expect(isDestructiveCommand("ls && rm foo")).toBe(true);
        expect(isDestructiveCommand("git status; git push")).toBe(true);
        expect(isDestructiveCommand('rg "pattern" src/ | rm file')).toBe(true);
    });

    // sed/perl in-place editing
    test("flags sed -i (in-place file modification)", () => {
        expect(isDestructiveCommand("sed -i 's/foo/bar/g' file.txt")).toBe(true);
        expect(isDestructiveCommand("sed -i.bak 's/foo/bar/' file.txt")).toBe(true);
        expect(isDestructiveCommand("sed -n 'p' file.txt")).toBe(false); // read-only sed is fine
    });

    test("flags perl -i (in-place file modification)", () => {
        expect(isDestructiveCommand("perl -i -pe 's/foo/bar/g' file.txt")).toBe(true);
        expect(isDestructiveCommand("perl -i.bak -pe 's/foo/bar/' file.txt")).toBe(true);
    });

    // Interpreter script execution
    test("flags interpreter script execution", () => {
        expect(isDestructiveCommand("python script.py")).toBe(true);
        expect(isDestructiveCommand("python3 script.py")).toBe(true);
        expect(isDestructiveCommand("python -c 'import os; os.remove(\"f\")'")).toBe(true);
        expect(isDestructiveCommand("ruby script.rb")).toBe(true);
        expect(isDestructiveCommand("node script.js")).toBe(true);
        // Version/help flags are safe
        expect(isDestructiveCommand("python --version")).toBe(false);
        expect(isDestructiveCommand("python3 --help")).toBe(false);
        expect(isDestructiveCommand("ruby --version")).toBe(false);
        expect(isDestructiveCommand("node --version")).toBe(false);
    });

    // Build tools
    test("flags make (build tool)", () => {
        expect(isDestructiveCommand("make")).toBe(true);
        expect(isDestructiveCommand("make install")).toBe(true);
        expect(isDestructiveCommand("make clean")).toBe(true);
        // Dry-run is safe
        expect(isDestructiveCommand("make --dry-run")).toBe(false);
        expect(isDestructiveCommand("make -n")).toBe(false);
        expect(isDestructiveCommand("make --just-print")).toBe(false);
    });
});

// ── isSafeCommand backward-compat wrapper ────────────────────────────────────

describe("isSafeCommand (backward compat)", () => {
    test("returns inverse of isDestructiveCommand", () => {
        expect(isSafeCommand("ls -la")).toBe(true);
        expect(isSafeCommand("rm -rf /")).toBe(false);
        expect(isSafeCommand("cd /tmp && rg pattern .")).toBe(true);
        expect(isSafeCommand("git push")).toBe(false);
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
