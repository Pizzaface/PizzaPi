/**
 * Windows command resolution for stdio MCP servers.
 *
 * Node/Bun cannot spawn `.cmd`/`.bat` files directly (CreateProcess only
 * understands real executables, and recent Node versions hard-error with
 * EINVAL). The overwhelmingly common MCP config (`command: "npx"`) resolves to
 * `npx.cmd` on Windows, so a bare spawn fails. This module resolves a command
 * through PATH + PATHEXT the way the shell would, and rewrites `.cmd`/`.bat`
 * invocations to run through `cmd.exe /d /s /c` with explicit quoting.
 */

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, resolve as pathResolve } from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface SpawnInvocation {
    command: string;
    args: string[];
    /** Set when args are pre-quoted for cmd.exe and must not be re-escaped. */
    windowsVerbatimArguments?: boolean;
}

/**
 * Resolve a command name to the on-disk file it would execute, following
 * PATH (for bare names) and PATHEXT (for extension-less names).
 * Returns null when nothing matches — the caller falls back to spawning the
 * original command and surfacing the OS error.
 */
export function resolveWindowsExecutable(command: string): string | null {
    const exts = (process.env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(";")
        .filter(Boolean);

    // For extension-less names, PATHEXT candidates come first: an extension-less
    // file on disk (e.g. the POSIX `npx` shell script next to `npx.cmd`) is not
    // something CreateProcess can execute.
    const candidatesFor = (base: string): string[] => {
        const lower = base.toLowerCase();
        const withExts = exts.map((e) => base + e.toLowerCase());
        const hasExecExt = exts.some((e) => lower.endsWith(e.toLowerCase()));
        return hasExecExt ? [base, ...withExts] : [...withExts, base];
    };

    const hasPathPart = command.includes("/") || command.includes("\\") || isAbsolute(command);
    if (hasPathPart) {
        for (const candidate of candidatesFor(pathResolve(command))) {
            if (existsSync(candidate)) return candidate;
        }
        return null;
    }

    const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        for (const candidate of candidatesFor(pathResolve(dir, command))) {
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/** Quote a single argument for a cmd.exe command line. */
export function quoteForCmd(s: string): string {
    if (s === "") return '""';
    if (!/[\s"&|<>^%()!]/.test(s)) return s;
    // Double preceding backslashes and escape embedded quotes (MSVCRT rules).
    return '"' + s.replace(/(\\*)"/g, '$1$1\\"') + '"';
}

/**
 * Build the spawn invocation for a configured command + args.
 * On non-Windows platforms (or for real executables) this is the identity.
 */
export function buildSpawnInvocation(command: string, args: string[]): SpawnInvocation {
    if (process.platform !== "win32") return { command, args };

    const resolved = resolveWindowsExecutable(command);
    if (!resolved) return { command, args };

    if (!/\.(cmd|bat)$/i.test(resolved)) {
        // A real executable — spawn the resolved path directly so PATHEXT
        // resolution isn't left to CreateProcess (which only tries .exe).
        return { command: resolved, args };
    }

    // .cmd/.bat: run through cmd.exe. /d skips AutoRun, /s preserves the
    // outer quotes around the full command line.
    const commandLine = [resolved, ...args].map(quoteForCmd).join(" ");
    return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", `"${commandLine}"`],
        windowsVerbatimArguments: true,
    };
}
