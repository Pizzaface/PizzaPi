/**
 * POSIX shell resolution.
 *
 * The bash tool (and hook/plugin runners in the CLI) execute agent- and
 * user-authored command strings that assume POSIX semantics. On Windows the
 * default `exec()` shell is cmd.exe, which breaks most of those commands —
 * Git for Windows' bundled bash.exe is the standard non-WSL substitute.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Find Git for Windows' bundled bash.exe by checking well-known install
 * paths and falling back to `git --exec-path` to derive the Git root.
 * Returns the absolute path to bash.exe, or null if not found.
 */
export function findGitBashOnWindows(): string | null {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";

    const candidates = [
        join(programFiles, "Git", "bin", "bash.exe"),
        join(programFilesX86, "Git", "bin", "bash.exe"),
        ...(localAppData ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }

    // Try to derive from `git --exec-path` (e.g. C:\Program Files\Git\mingw64\libexec\git-core)
    try {
        const execPath = execSync("git --exec-path", {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        // Walk up to the Git root: <root>/mingw64/libexec/git-core → <root>
        const gitRoot = join(execPath, "..", "..", "..");
        const bashFromGit = join(gitRoot, "bin", "bash.exe");
        if (existsSync(bashFromGit)) return bashFromGit;
    } catch {
        // git not in PATH or other error — fall through
    }

    return null;
}

/** Cached result so the filesystem is only probed once per process. */
let _cachedShell: { shell: string; flag: string } | null | undefined;

/**
 * Resolve a POSIX-compatible shell for running command strings.
 *
 * - **Unix / macOS**: `/bin/sh -c` (POSIX-guaranteed to exist).
 * - **Windows**: Git for Windows' bundled `bash.exe`, or null when no
 *   git-bash could be found — callers decide their own fallback (cmd.exe
 *   default, bare `bash`, or a clear error).
 */
export function resolvePosixShell(): { shell: string; flag: string } | null {
    if (_cachedShell !== undefined) return _cachedShell;

    if (process.platform !== "win32") {
        _cachedShell = { shell: "/bin/sh", flag: "-c" };
        return _cachedShell;
    }

    const gitBash = findGitBashOnWindows();
    _cachedShell = gitBash ? { shell: gitBash, flag: "-c" } : null;
    return _cachedShell;
}

/** Test hook: clear the cached shell resolution. */
export function _resetPosixShellCache(): void {
    _cachedShell = undefined;
}
