import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getShellArgs, resolveDefaultShell } from "./terminal-utils.js";

// ─── getShellArgs ──────────────────────────────────────────────────────────────

describe("getShellArgs", () => {
    // -- POSIX shells → ["-il"] -------------------------------------------

    test("bash → interactive login flags", () => {
        expect(getShellArgs("/bin/bash")).toEqual(["-il"]);
    });

    test("zsh → interactive login flags", () => {
        expect(getShellArgs("/bin/zsh")).toEqual(["-il"]);
    });

    test("sh → interactive login flags", () => {
        expect(getShellArgs("/bin/sh")).toEqual(["-il"]);
    });

    test("fish → interactive login flags", () => {
        expect(getShellArgs("/usr/bin/fish")).toEqual(["-il"]);
    });

    test("/usr/local/bin/bash → interactive login flags", () => {
        expect(getShellArgs("/usr/local/bin/bash")).toEqual(["-il"]);
    });

    // -- PowerShell → ["-NoExit", "-NoLogo"] ------------------------------

    test("powershell.exe → NoExit + NoLogo", () => {
        expect(getShellArgs("powershell.exe")).toEqual(["-NoExit", "-NoLogo"]);
    });

    test("pwsh.exe → NoExit + NoLogo", () => {
        expect(getShellArgs("pwsh.exe")).toEqual(["-NoExit", "-NoLogo"]);
    });

    test("pwsh (no extension) → NoExit + NoLogo", () => {
        expect(getShellArgs("pwsh")).toEqual(["-NoExit", "-NoLogo"]);
    });

    test("Windows full path to powershell → NoExit + NoLogo", () => {
        expect(getShellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
            .toEqual(["-NoExit", "-NoLogo"]);
    });

    test("Windows full path to pwsh → NoExit + NoLogo", () => {
        expect(getShellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe"))
            .toEqual(["-NoExit", "-NoLogo"]);
    });

    test("case insensitive: PowerShell.exe → NoExit + NoLogo", () => {
        // Windows paths can have mixed case
        expect(getShellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe"))
            .toEqual(["-NoExit", "-NoLogo"]);
    });

    // -- cmd.exe → [] -----------------------------------------------------

    test("cmd.exe → empty args", () => {
        expect(getShellArgs("cmd.exe")).toEqual([]);
    });

    test("cmd (no extension) → empty args", () => {
        expect(getShellArgs("cmd")).toEqual([]);
    });

    test("Windows full path to cmd.exe → empty args", () => {
        expect(getShellArgs("C:\\Windows\\System32\\cmd.exe")).toEqual([]);
    });

    // -- Edge cases -------------------------------------------------------

    test("empty string → falls back to POSIX flags", () => {
        expect(getShellArgs("")).toEqual(["-il"]);
    });

    test("forward-slash Windows path → still detects powershell", () => {
        expect(getShellArgs("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"))
            .toEqual(["-NoExit", "-NoLogo"]);
    });

    test("nushell (nu) → POSIX flags (unrecognized shell)", () => {
        expect(getShellArgs("/usr/bin/nu")).toEqual(["-il"]);
    });
});

// ─── resolveDefaultShell ───────────────────────────────────────────────────────

describe("resolveDefaultShell", () => {
    let originalShell: string | undefined;

    beforeEach(() => {
        originalShell = process.env.SHELL;
    });

    afterEach(() => {
        if (originalShell !== undefined) {
            process.env.SHELL = originalShell;
        } else {
            delete process.env.SHELL;
        }
    });

    test("returns explicit shell when provided", () => {
        expect(resolveDefaultShell("/usr/local/bin/fish")).toBe("/usr/local/bin/fish");
    });

    test("explicit shell takes priority over $SHELL", () => {
        process.env.SHELL = "/bin/zsh";
        expect(resolveDefaultShell("/bin/bash")).toBe("/bin/bash");
    });

    test("falls back to $SHELL when no explicit shell", () => {
        process.env.SHELL = "/bin/zsh";
        expect(resolveDefaultShell()).toBe("/bin/zsh");
        expect(resolveDefaultShell("")).toBe("/bin/zsh");
    });

    test("falls back to platform default when $SHELL is unset", () => {
        delete process.env.SHELL;
        const result = resolveDefaultShell();
        // On this platform it should be /bin/bash (macOS/Linux) or powershell.exe (Windows)
        expect(result === "/bin/bash" || result === "powershell.exe").toBe(true);
    });

    test("empty string explicit is treated as falsy (falls through)", () => {
        process.env.SHELL = "/bin/zsh";
        expect(resolveDefaultShell("")).toBe("/bin/zsh");
    });
});
