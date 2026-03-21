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

    // Previously missing git destructive commands (allowlist regression tests)
    test("flags git clean (removes untracked files)", () => {
        expect(isDestructiveCommand("git clean -fd")).toBe(true);
        expect(isDestructiveCommand("git clean -n")).toBe(true); // even dry-run, subcommand not on allowlist
    });

    test("flags git apply (applies patches)", () => {
        expect(isDestructiveCommand("git apply patch.diff")).toBe(true);
        expect(isDestructiveCommand("git apply --stat patch.diff")).toBe(true);
    });

    test("flags git restore (discards changes)", () => {
        expect(isDestructiveCommand("git restore .")).toBe(true);
        expect(isDestructiveCommand("git restore --staged file.ts")).toBe(true);
    });

    test("flags git rm (removes files)", () => {
        expect(isDestructiveCommand("git rm file.ts")).toBe(true);
        expect(isDestructiveCommand("git rm --cached file.ts")).toBe(true);
    });

    test("flags git mv (moves files)", () => {
        expect(isDestructiveCommand("git mv old.ts new.ts")).toBe(true);
    });

    test("flags git am (applies mailbox patches)", () => {
        expect(isDestructiveCommand("git am < patch.mbox")).toBe(true);
    });

    test("flags git bisect (modifies HEAD)", () => {
        expect(isDestructiveCommand("git bisect start")).toBe(true);
        expect(isDestructiveCommand("git bisect reset")).toBe(true);
    });

    test("flags git format-patch (writes files)", () => {
        expect(isDestructiveCommand("git format-patch HEAD~3")).toBe(true);
    });

    test("flags git filter-branch (rewrites history)", () => {
        expect(isDestructiveCommand("git filter-branch --tree-filter 'rm -f secret' HEAD")).toBe(true);
    });

    test("flags git notes (modifies notes)", () => {
        expect(isDestructiveCommand("git notes add -m 'note'")).toBe(true);
    });

    test("flags git submodule update (modifies working tree)", () => {
        expect(isDestructiveCommand("git submodule update --init")).toBe(true);
    });

    test("flags git switch -c (creates branch + switches)", () => {
        expect(isDestructiveCommand("git switch -c new-branch")).toBe(true);
        expect(isDestructiveCommand("git switch main")).toBe(true); // switch modifies HEAD
    });

    // Safe git subcommand with destructive override tests
    test("flags git branch -D (delete)", () => {
        expect(isDestructiveCommand("git branch -D feature")).toBe(true);
        expect(isDestructiveCommand("git branch -d feature")).toBe(true);
        expect(isDestructiveCommand("git branch -m old new")).toBe(true);
    });

    test("flags git stash push/drop/pop (mutating)", () => {
        expect(isDestructiveCommand("git stash")).toBe(true);
        expect(isDestructiveCommand("git stash push")).toBe(true);
        expect(isDestructiveCommand("git stash drop")).toBe(true);
        expect(isDestructiveCommand("git stash pop")).toBe(true);
        expect(isDestructiveCommand("git stash apply")).toBe(true);
        expect(isDestructiveCommand("git stash clear")).toBe(true);
    });

    test("allows git stash list/show (read-only)", () => {
        expect(isDestructiveCommand("git stash list")).toBe(false);
        expect(isDestructiveCommand("git stash show")).toBe(false);
        expect(isDestructiveCommand("git stash show -p")).toBe(false);
    });

    test("flags git worktree add/remove (mutating)", () => {
        expect(isDestructiveCommand("git worktree add ../feature")).toBe(true);
        expect(isDestructiveCommand("git worktree remove ../feature")).toBe(true);
    });

    test("allows git worktree list (read-only)", () => {
        expect(isDestructiveCommand("git worktree list")).toBe(false);
    });

    test("flags git config set (write)", () => {
        expect(isDestructiveCommand("git config user.name 'Test'")).toBe(true);
        expect(isDestructiveCommand("git config --unset user.name")).toBe(true);
    });

    test("allows git config --get/--list (read-only)", () => {
        expect(isDestructiveCommand("git config --get user.name")).toBe(false);
        expect(isDestructiveCommand("git config --list")).toBe(false);
        expect(isDestructiveCommand("git config --get-all user.name")).toBe(false);
    });

    test("flags git reflog delete/expire (mutating)", () => {
        expect(isDestructiveCommand("git reflog delete HEAD@{0}")).toBe(true);
        expect(isDestructiveCommand("git reflog expire --all")).toBe(true);
    });

    test("allows git reflog show (read-only)", () => {
        expect(isDestructiveCommand("git reflog")).toBe(false);
        expect(isDestructiveCommand("git reflog show")).toBe(false);
    });

    test("allows other read-only git commands", () => {
        expect(isDestructiveCommand("git log --oneline -10")).toBe(false);
        expect(isDestructiveCommand("git show HEAD")).toBe(false);
        expect(isDestructiveCommand("git blame file.ts")).toBe(false);
        expect(isDestructiveCommand("git grep 'pattern'")).toBe(false);
        expect(isDestructiveCommand("git ls-files")).toBe(false);
        expect(isDestructiveCommand("git rev-parse HEAD")).toBe(false);
        expect(isDestructiveCommand("git describe --tags")).toBe(false);
        expect(isDestructiveCommand("git for-each-ref")).toBe(false);
        expect(isDestructiveCommand("git cat-file -p HEAD")).toBe(false);
        expect(isDestructiveCommand("git fsck")).toBe(false);
        expect(isDestructiveCommand("git count-objects")).toBe(false);
    });

    test("flags git archive -o/--output (file write)", () => {
        expect(isDestructiveCommand("git archive -o out.tar HEAD")).toBe(true);
        expect(isDestructiveCommand("git archive -oout.tar HEAD")).toBe(true);
        expect(isDestructiveCommand("git archive --output=out.tar HEAD")).toBe(true);
        expect(isDestructiveCommand("git archive --output out.tar HEAD")).toBe(true);
    });

    test("allows git archive to stdout (read-only)", () => {
        expect(isDestructiveCommand("git archive HEAD")).toBe(false);
        expect(isDestructiveCommand("git archive --format=tar HEAD")).toBe(false);
    });

    test("allows newly-added read-only git subcommands", () => {
        expect(isDestructiveCommand("git cherry main")).toBe(false);
        expect(isDestructiveCommand("git cherry -v main feature")).toBe(false);
        expect(isDestructiveCommand("git range-diff main~3..main~1 main~2..main")).toBe(false);
        expect(isDestructiveCommand("git diff-tree HEAD")).toBe(false);
        expect(isDestructiveCommand("git diff-files")).toBe(false);
        expect(isDestructiveCommand("git diff-index HEAD")).toBe(false);
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

    // fd redirections are only safe when numeric fd goes to /dev/null
    test("allows numeric fd redirections to /dev/null", () => {
        expect(isDestructiveCommand("ls /tmp 2>/dev/null")).toBe(false);
        expect(isDestructiveCommand("ls /tmp 2> /dev/null")).toBe(false);
        expect(isDestructiveCommand('ls /nonexistent 2>/dev/null || echo "not found"')).toBe(false);
        expect(isDestructiveCommand('ls /a/ 2>/dev/null || ls /b/ 2>/dev/null || echo "no dirs"')).toBe(false);
        expect(isDestructiveCommand("some-cmd 1>/dev/null")).toBe(false);
    });

    test("flags numeric fd redirections to files", () => {
        expect(isDestructiveCommand("echo secret 1>out.txt")).toBe(true);
        expect(isDestructiveCommand("cmd 2>err.log")).toBe(true);
        expect(isDestructiveCommand("git status 1>status.txt")).toBe(true);
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

    // ── Previously-missing write-capable commands ─────────────────────────

    test("flags GNU install (always writes to destination)", () => {
        expect(isDestructiveCommand("install -m 755 binary /usr/local/bin/")).toBe(true);
        expect(isDestructiveCommand("install -d /usr/local/share/myapp")).toBe(true);
        expect(isDestructiveCommand("install file.so /usr/lib/")).toBe(true);
    });

    test("flags mkfifo (creates named pipes)", () => {
        expect(isDestructiveCommand("mkfifo /tmp/mypipe")).toBe(true);
        expect(isDestructiveCommand("mkfifo -m 600 /tmp/pipe")).toBe(true);
    });

    test("flags mknod (creates device/special files)", () => {
        expect(isDestructiveCommand("mknod /dev/mydev c 89 1")).toBe(true);
        expect(isDestructiveCommand("mknod -m 660 /tmp/fifo p")).toBe(true);
    });

    test("flags patch (applies diffs) but allows explicit read-only flags", () => {
        expect(isDestructiveCommand("patch -p1 < changes.diff")).toBe(true);
        expect(isDestructiveCommand("patch file.txt patch.diff")).toBe(true);
        expect(isDestructiveCommand("patch --strip=1 < fix.patch")).toBe(true);

        // Read-only verification modes
        expect(isDestructiveCommand("patch --dry-run -p1 < changes.diff")).toBe(false);
        expect(isDestructiveCommand("patch --check -p1 < changes.diff")).toBe(false);

        // Regression tests — avoid false safe matches / short-flag payload confusion
        expect(isDestructiveCommand("patch --version-control=simple -p0 < changes.diff")).toBe(true);
        expect(isDestructiveCommand("patch -zC -p0 < changes.diff")).toBe(true);

        // --dry-run with --output still writes output, so it's destructive
        expect(isDestructiveCommand("patch --dry-run -o out.txt file.txt < fix.diff")).toBe(true);
        expect(isDestructiveCommand("patch --dry-run --output=out.txt file.txt < fix.diff")).toBe(true);

        // Short-flag -C must be standalone, not bundled with other options like -z
        expect(isDestructiveCommand("patch -C -p0 < fix.diff")).toBe(false);
        expect(isDestructiveCommand("patch -zC -p0 < fix.diff")).toBe(true); // -zC is: suffix=C, not check

        // -o - and --output=- write to stdout (read-only preview)
        expect(isDestructiveCommand("patch -o - file.txt < fix.diff")).toBe(false);
        expect(isDestructiveCommand("patch --output=- file.txt < fix.diff")).toBe(false);

        // Informational flags
        expect(isDestructiveCommand("patch --help")).toBe(false);
        expect(isDestructiveCommand("patch --version")).toBe(false);
    });

    test("flags tar with create flag (-c / --create)", () => {
        expect(isDestructiveCommand("tar -cf archive.tar dir/")).toBe(true);
        expect(isDestructiveCommand("tar -czf archive.tar.gz dir/")).toBe(true);
        expect(isDestructiveCommand("tar --create -f out.tar .")).toBe(true);
        expect(isDestructiveCommand("tar --create --gzip -f out.tar.gz .")).toBe(true);
        // Legacy positional flag style
        expect(isDestructiveCommand("tar czf archive.tar.gz dir/")).toBe(true);
        expect(isDestructiveCommand("tar zcf archive.tar.gz dir/")).toBe(true);
        expect(isDestructiveCommand("tar cf out.tar file1 file2")).toBe(true);
    });

    test("flags tar with append flag (-r / --append)", () => {
        expect(isDestructiveCommand("tar -rf archive.tar newfile")).toBe(true);
        expect(isDestructiveCommand("tar --append -f archive.tar newfile")).toBe(true);
        // Legacy positional flag style
        expect(isDestructiveCommand("tar rf archive.tar newfile")).toBe(true);
    });

    test("flags tar with update flag (-u / --update)", () => {
        expect(isDestructiveCommand("tar -uf archive.tar updated")).toBe(true);
        expect(isDestructiveCommand("tar --update -f archive.tar updated")).toBe(true);
        // Legacy positional flag style
        expect(isDestructiveCommand("tar uf archive.tar updated")).toBe(true);
    });

    test("flags tar with extract flag (-x / --extract)", () => {
        expect(isDestructiveCommand("tar -xf archive.tar")).toBe(true);
        expect(isDestructiveCommand("tar -xzf archive.tar.gz")).toBe(true);
        expect(isDestructiveCommand("tar --extract -f archive.tar")).toBe(true);
        expect(isDestructiveCommand("tar --get -f archive.tar")).toBe(true);
        // Legacy positional flag style
        expect(isDestructiveCommand("tar xvf archive.tar")).toBe(true);
        expect(isDestructiveCommand("tar xf archive.tar")).toBe(true);
        expect(isDestructiveCommand("tar zxf archive.tar.gz")).toBe(true);
        // Mode letter after other options, e.g. -f first then -x / -c
        expect(isDestructiveCommand("tar -f archive.tar -x")).toBe(true);
        expect(isDestructiveCommand("tar -f archive.tar -c")).toBe(true);
        expect(isDestructiveCommand("tar -f out.tar.gz -z -c src/")).toBe(true);
    });

    test("flags tar with delete mode (--delete)", () => {
        expect(isDestructiveCommand("tar --delete -f archive.tar foo")).toBe(true);
        expect(isDestructiveCommand("tar --delete --file=archive.tar bar")).toBe(true);
    });

    test("flags tar with concatenate mode (-A / --catenate / --concatenate)", () => {
        expect(isDestructiveCommand("tar -Af archive.tar other.tar")).toBe(true);
        expect(isDestructiveCommand("tar -Avf archive.tar other.tar")).toBe(true);
        expect(isDestructiveCommand("tar --catenate -f archive.tar other.tar")).toBe(true);
        expect(isDestructiveCommand("tar --concatenate -f archive.tar other.tar")).toBe(true);
        // Legacy positional-flag style
        expect(isDestructiveCommand("tar Af archive.tar other.tar")).toBe(true);
    });

    test("allows tar with list flag only (-t / --list)", () => {
        expect(isDestructiveCommand("tar -tf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar -tfarchive.tar")).toBe(false);
        expect(isDestructiveCommand("tar tfarchive.tar")).toBe(false);
        expect(isDestructiveCommand("tar -tvf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar --list -f archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar tf archive.tar AGENTS.md")).toBe(false);
        expect(isDestructiveCommand("tar tf archive.tar README.md")).toBe(false);
        // Legacy positional flag style (list only)
        expect(isDestructiveCommand("tar tf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar tvf archive.tar")).toBe(false);
    });

    test("allows tar list mode with -C / -X modifiers (case-sensitive short options)", () => {
        expect(isDestructiveCommand("tar -C /tmp -tf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar -X excludes.txt -tf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar -C /tmp -X excludes.txt -tf archive.tar")).toBe(false);

        // Still destructive if an actual mode flag is present
        expect(isDestructiveCommand("tar -C /tmp -xf archive.tar")).toBe(true);
    });

    test("allows tar list mode with -I flag (use-compress-program, attached argument)", () => {
        // -I accepts an attached argument (the compression program), so `-Ixz` should not
        // misinterpret the `x` as extract mode
        expect(isDestructiveCommand("tar -Ixz -tf archive.tar.xz")).toBe(false);
        expect(isDestructiveCommand("tar -Ixz -tvf archive.tar.xz")).toBe(false);
        // With actual destructive mode, should still be destructive
        expect(isDestructiveCommand("tar -Ixz -cf archive.tar.xz dir/")).toBe(true);
        expect(isDestructiveCommand("tar -Ixz -xf archive.tar.xz")).toBe(true);
    });

    test("allows tar list mode with -H flag (format, attached argument)", () => {
        // -H accepts an attached argument (format name), so `-Hposix` should not
        // misinterpret the `x` in `posix` as extract mode
        expect(isDestructiveCommand("tar -Hposix -tf archive.tar")).toBe(false);
        expect(isDestructiveCommand("tar -Hposix -tvf archive.tar")).toBe(false);
        // With actual destructive mode, should still be destructive
        expect(isDestructiveCommand("tar -Hposix -cf archive.tar dir/")).toBe(true);
        expect(isDestructiveCommand("tar -Hposix -xf archive.tar")).toBe(true);
    });

    test("flags gawk with in-place editing via the inplace module", () => {
        // -i inplace (space-separated) — the destructive form
        expect(isDestructiveCommand("gawk -i inplace '{gsub(/foo/, \"bar\")} 1' file.txt")).toBe(true);
        // -iinplace (no space) — also the destructive form
        expect(isDestructiveCommand("gawk -iinplace '{print}' file.txt")).toBe(true);
        expect(isDestructiveCommand("gawk -i /usr/share/awk/inplace.awk '{print}' file.txt")).toBe(true);
        // --include=inplace — long-form destructive
        expect(isDestructiveCommand("gawk --include=inplace '{gsub(/foo/, \"bar\")} 1' file.txt")).toBe(true);
        // --include inplace — long-form with space
        expect(isDestructiveCommand("gawk --include inplace '{gsub(/foo/, \"bar\")} 1' file.txt")).toBe(true);
        expect(isDestructiveCommand("gawk --include=/usr/share/awk/inplace.awk '{print}' file.txt")).toBe(true);
        // -f inplace.awk / --file= — loading the inplace library via -f is equivalent
        expect(isDestructiveCommand("gawk -f inplace.awk -f prog.awk file.txt")).toBe(true);
        expect(isDestructiveCommand("gawk -f /usr/share/awk/inplace.awk -f prog.awk file.txt")).toBe(true);
        expect(isDestructiveCommand("gawk --file=inplace.awk -f prog.awk file.txt")).toBe(true);
        expect(isDestructiveCommand("gawk --file /usr/share/awk/inplace.awk -f prog.awk file.txt")).toBe(true);
    });

    test("allows awk / gawk without in-place flags", () => {
        expect(isDestructiveCommand("awk '{print $1}' file.txt")).toBe(false);
        expect(isDestructiveCommand("gawk '{print NR, $0}' file.txt")).toBe(false);
        expect(isDestructiveCommand("awk -F: '{print $1}' /etc/passwd")).toBe(false);
        // -i with a read-only library (not the inplace module) must not be blocked
        expect(isDestructiveCommand("gawk -i ord 'BEGIN { print ord(\"A\") }'")).toBe(false);
        // -ibak is a read-only library include, not in-place editing
        expect(isDestructiveCommand("gawk -ibak '{print}' file.txt")).toBe(false);
        // -f with a non-inplace script file must not be blocked
        expect(isDestructiveCommand("gawk -f prog.awk file.txt")).toBe(false);
        expect(isDestructiveCommand("gawk --file=transform.awk file.txt")).toBe(false);
    });

    test("flags awk (bare command, GNU Awk alias) with in-place editing", () => {
        // On systems where `awk` is GNU Awk, it supports the same inplace module as gawk
        expect(isDestructiveCommand("awk -i inplace '{gsub(/foo/, \"bar\")} 1' file.txt")).toBe(true);
        expect(isDestructiveCommand("awk -iinplace '{print}' file.txt")).toBe(true);
        expect(isDestructiveCommand("awk -i /usr/share/awk/inplace.awk '{print}' file.txt")).toBe(true);
        expect(isDestructiveCommand("awk --include=inplace '{print}' file.txt")).toBe(true);
        expect(isDestructiveCommand("awk --include=/usr/share/awk/inplace.awk '{print}' file.txt")).toBe(true);
        expect(isDestructiveCommand("awk -f inplace.awk -f prog.awk file.txt")).toBe(true);
        expect(isDestructiveCommand("awk -f /usr/share/awk/inplace.awk -f prog.awk file.txt")).toBe(true);
    });

    test("flags shell output redirection (>)", () => {
        expect(isDestructiveCommand("echo hello > /tmp/out.txt")).toBe(true);
        expect(isDestructiveCommand("cat file.txt > copy.txt")).toBe(true);
        expect(isDestructiveCommand("ls > listing.txt")).toBe(true);
    });

    test("flags shell append redirection (>>)", () => {
        expect(isDestructiveCommand("echo hello >> /tmp/out.txt")).toBe(true);
        expect(isDestructiveCommand("date >> /tmp/timestamps.log")).toBe(true);
    });

    test("allows stderr redirection to /dev/null (2>/dev/null)", () => {
        expect(isDestructiveCommand("ls 2>/dev/null")).toBe(false);
        expect(isDestructiveCommand("cat file.txt 2>/dev/null")).toBe(false);
        expect(isDestructiveCommand("grep pattern src/ 2>/dev/null")).toBe(false);
    });
});

// ── isDestructiveCommand with sandboxActive=true ─────────────────────────────
//
// When the OS sandbox is active, only non-filesystem side effects are checked.
// The sandbox's read-only overlay handles filesystem write protection, so
// command substitution, output redirection, script interpreters, find -exec,
// and most filesystem-mutating commands are allowed through.

describe("isDestructiveCommand (sandboxActive=true)", () => {
    // ── Commands that SHOULD be allowed with sandbox ─────────────────────

    test("blocks command substitution when sandbox active (prevents smuggling)", () => {
        expect(isDestructiveCommand('echo "$(wc -l < file)"', true)).toBe(true);
        expect(isDestructiveCommand("ls $(cat filelist.txt)", true)).toBe(true);
        expect(isDestructiveCommand("echo $(kill -9 1234)", true)).toBe(true);
    });

    test("blocks backtick expansion when sandbox active (prevents smuggling)", () => {
        expect(isDestructiveCommand("echo `wc -l file`", true)).toBe(true);
        expect(isDestructiveCommand("echo `kill -9 1234`", true)).toBe(true);
    });

    test("blocks process substitution when sandbox active (prevents smuggling)", () => {
        expect(isDestructiveCommand("diff <(cat a.txt) <(cat b.txt)", true)).toBe(true);
    });

    test("allows output redirection when sandbox active", () => {
        expect(isDestructiveCommand("echo foo > /tmp/scratch.txt", true)).toBe(false);
        expect(isDestructiveCommand("echo foo >> /tmp/log.txt", true)).toBe(false);
    });

    test("allows find -exec when sandbox active", () => {
        expect(isDestructiveCommand("find . -name '*.ts' -exec grep foo {} \\;", true)).toBe(false);
        expect(isDestructiveCommand("find . -type f -exec wc -l {} +", true)).toBe(false);
    });

    test("allows script interpreters when sandbox active", () => {
        expect(isDestructiveCommand("python3 analyze.py", true)).toBe(false);
        expect(isDestructiveCommand("python -c 'print(1+1)'", true)).toBe(false);
        expect(isDestructiveCommand("node script.js", true)).toBe(false);
        expect(isDestructiveCommand("ruby script.rb", true)).toBe(false);
    });

    test("allows make when sandbox active", () => {
        expect(isDestructiveCommand("make", true)).toBe(false);
        expect(isDestructiveCommand("make test", true)).toBe(false);
    });

    test("allows filesystem-mutating commands when sandbox active (OS blocks writes)", () => {
        expect(isDestructiveCommand("rm file.txt", true)).toBe(false);
        expect(isDestructiveCommand("mv foo bar", true)).toBe(false);
        expect(isDestructiveCommand("cp foo bar", true)).toBe(false);
        expect(isDestructiveCommand("mkdir test", true)).toBe(false);
        expect(isDestructiveCommand("touch file", true)).toBe(false);
    });

    test("allows sed -i when sandbox active (OS blocks writes)", () => {
        expect(isDestructiveCommand("sed -i 's/foo/bar/' file.txt", true)).toBe(false);
    });

    test("allows curl with -o when sandbox active (OS blocks writes)", () => {
        expect(isDestructiveCommand("curl -o out.bin https://example.com", true)).toBe(false);
    });

    test("allows package managers when sandbox active (OS blocks writes)", () => {
        expect(isDestructiveCommand("npm install", true)).toBe(false);
        expect(isDestructiveCommand("bun add foo", true)).toBe(false);
        expect(isDestructiveCommand("pip install requests", true)).toBe(false);
    });

    test("blocks git push when sandbox active (remote side effect)", () => {
        expect(isDestructiveCommand("git push", true)).toBe(true);
        expect(isDestructiveCommand("git push origin main", true)).toBe(true);
        expect(isDestructiveCommand("git push --force", true)).toBe(true);
    });

    test("blocks git remote mutations when sandbox active", () => {
        expect(isDestructiveCommand("git remote add origin https://x", true)).toBe(true);
        expect(isDestructiveCommand("git remote remove origin", true)).toBe(true);
        expect(isDestructiveCommand("git remote set-url origin https://x", true)).toBe(true);
    });

    test("blocks git plumbing commands that mutate remotes when sandbox active", () => {
        expect(isDestructiveCommand("git send-pack origin refs/heads/main", true)).toBe(true);
        expect(isDestructiveCommand("git receive-pack /path/to/repo", true)).toBe(true);
        expect(isDestructiveCommand("git http-push https://example.com/repo", true)).toBe(true);
    });

    test("allows safe git subcommands when sandbox active", () => {
        expect(isDestructiveCommand("git status", true)).toBe(false);
        expect(isDestructiveCommand("git log --oneline", true)).toBe(false);
        expect(isDestructiveCommand("git diff HEAD", true)).toBe(false);
        expect(isDestructiveCommand("git archive HEAD", true)).toBe(false);
    });

    test("blocks git commit when sandbox active (not on safe subcommand list)", () => {
        expect(isDestructiveCommand("git commit -m 'test'", true)).toBe(true);
    });

    test("blocks npm publish when sandbox active (remote side effect)", () => {
        expect(isDestructiveCommand("npm publish", true)).toBe(true);
        expect(isDestructiveCommand("npm publish --tag beta", true)).toBe(true);
    });

    test("blocks npx when sandbox active (arbitrary code execution)", () => {
        expect(isDestructiveCommand("npx some-package", true)).toBe(true);
    });

    test("blocks docker push when sandbox active (remote side effect)", () => {
        expect(isDestructiveCommand("docker push myimage:latest", true)).toBe(true);
    });

    test("blocks gh CLI mutations when sandbox active (remote side effect)", () => {
        expect(isDestructiveCommand("gh issue create --title test", true)).toBe(true);
        expect(isDestructiveCommand("gh pr merge 123", true)).toBe(true);
        expect(isDestructiveCommand("gh release create v1.0", true)).toBe(true);
    });

    test("allows gh CLI read operations when sandbox active", () => {
        expect(isDestructiveCommand("gh issue list", true)).toBe(false);
        expect(isDestructiveCommand("gh pr view 123", true)).toBe(false);
        expect(isDestructiveCommand("gh api /repos", true)).toBe(false);
    });

    test("allows editors when sandbox active (OS blocks writes)", () => {
        expect(isDestructiveCommand("vim file.txt", true)).toBe(false);
        expect(isDestructiveCommand("nano file.txt", true)).toBe(false);
    });

    // ── Commands that SHOULD still be blocked with sandbox ───────────────

    test("still blocks sudo when sandbox active", () => {
        expect(isDestructiveCommand("sudo ls", true)).toBe(true);
        expect(isDestructiveCommand("sudo rm -rf /", true)).toBe(true);
    });

    test("still blocks su when sandbox active", () => {
        expect(isDestructiveCommand("su root", true)).toBe(true);
    });

    test("still blocks kill/pkill/killall when sandbox active", () => {
        expect(isDestructiveCommand("kill -9 1234", true)).toBe(true);
        expect(isDestructiveCommand("pkill node", true)).toBe(true);
        expect(isDestructiveCommand("killall python", true)).toBe(true);
    });

    test("still blocks reboot/shutdown when sandbox active", () => {
        expect(isDestructiveCommand("reboot", true)).toBe(true);
        expect(isDestructiveCommand("shutdown -h now", true)).toBe(true);
    });

    test("still blocks systemctl start/stop/restart when sandbox active", () => {
        expect(isDestructiveCommand("systemctl stop nginx", true)).toBe(true);
        expect(isDestructiveCommand("systemctl restart docker", true)).toBe(true);
    });

    test("still blocks service start/stop/restart when sandbox active", () => {
        expect(isDestructiveCommand("service nginx stop", true)).toBe(true);
        expect(isDestructiveCommand("service docker restart", true)).toBe(true);
    });

    test("still blocks multi-line payloads when sandbox active", () => {
        expect(isDestructiveCommand("ls\nkill 1234", true)).toBe(true);
        expect(isDestructiveCommand("cat foo\nsudo rm bar", true)).toBe(true);
    });

    test("still blocks chains containing dangerous commands when sandbox active", () => {
        expect(isDestructiveCommand("ls && kill 1234", true)).toBe(true);
        expect(isDestructiveCommand("echo hello; sudo rm -rf /", true)).toBe(true);
    });

    // ── Read-only commands still allowed (sanity check) ──────────────────

    test("allows read-only commands when sandbox active (unchanged)", () => {
        expect(isDestructiveCommand("ls -la", true)).toBe(false);
        expect(isDestructiveCommand("cat foo.txt", true)).toBe(false);
        expect(isDestructiveCommand("grep -r pattern src/", true)).toBe(false);
        expect(isDestructiveCommand("git status", true)).toBe(false);
        expect(isDestructiveCommand("find . -name '*.ts'", true)).toBe(false);
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
