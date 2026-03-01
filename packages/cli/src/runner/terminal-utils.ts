/**
 * Shared terminal utilities — pure functions with no side effects.
 *
 * Extracted so they can be unit-tested without spawning a PTY or subprocess.
 */

import { platform } from "node:os";

/**
 * Determine shell arguments based on the shell executable.
 *
 * `-il` (interactive login) is only valid for POSIX shells (bash, zsh, etc.).
 * PowerShell and cmd.exe don't understand these flags and will exit immediately
 * with code 1.
 */
export function getShellArgs(shellPath: string): string[] {
    const base = shellPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
    // PowerShell (powershell.exe, pwsh.exe, pwsh) — use -NoExit for interactive
    if (base.startsWith("powershell") || base.startsWith("pwsh")) {
        return ["-NoExit", "-NoLogo"];
    }
    // cmd.exe — no special args needed for interactive mode
    if (base === "cmd.exe" || base === "cmd") {
        return [];
    }
    // POSIX shells (bash, zsh, fish, sh, etc.)
    return ["-il"];
}

/**
 * Resolve the default shell for the current platform.
 *
 * Prefers an explicit `shell` argument, then `$SHELL`, then a
 * platform-appropriate default (PowerShell on Windows, /bin/bash elsewhere).
 */
export function resolveDefaultShell(explicit?: string): string {
    if (explicit) return explicit;
    if (process.env.SHELL) return process.env.SHELL;
    return platform() === "win32" ? "powershell.exe" : "/bin/bash";
}
