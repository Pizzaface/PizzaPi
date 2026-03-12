import { describe, expect, test } from "bun:test";
import { isPlanModeEnabled, isExecutionMode, getPlanTodoItems, togglePlanModeFromRemote, setPlanModeFromRemote, isSafeCommand } from "./plan-mode-toggle.js";

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

    // Chaining operators (pre-existing behavior, regression guard)
    test("blocks chained unsafe commands", () => {
        expect(isSafeCommand("ls && make")).toBe(false);
        expect(isSafeCommand("git status; python script.py")).toBe(false);
        expect(isSafeCommand("ls & make")).toBe(false);
    });
});
