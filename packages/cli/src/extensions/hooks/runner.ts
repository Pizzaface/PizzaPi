import { resolvePosixShell } from "@pizzapi/tools";
import type { HookEntry } from "../../config.js";
import { expandVars } from "../../config.js";
import type { HookOutput, HookResult } from "./types.js";

/**
 * Minimal subset of Bun.spawn's interface required by runHook.
 * Exported so tests can inject a fake spawn layer without spawning real processes.
 */
export type SpawnLike = (
    args: string[],
    options: unknown,
) => {
    stdin: { write(data: string): void; end(): void };
    exited: Promise<number>;
    kill(signal?: number): void;
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
    signalCode: string | null;
};

// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------

/** Cached result so we only probe the filesystem once per process. */
let _cachedShell: { shell: string; flag: string } | undefined;

/**
 * Resolve the platform shell and flag for running hook commands.
 *
 * - **Unix / macOS**: `/bin/sh -c` (POSIX-guaranteed to exist). Hook
 *   scripts that need bash features should have a `#!/bin/bash` shebang
 *   or be invoked explicitly via `bash my-script.sh` in the command string.
 * - **Windows**: Git for Windows' bundled `bash.exe` (searched at common
 *   install locations, then derived from `git --exec-path`). Falls back to
 *   bare `bash` in PATH so the error message is clear ("bash not found")
 *   rather than an opaque cmd.exe syntax failure.
 *
 * The result is cached for the lifetime of the process.
 */
export function resolveShell(): { shell: string; flag: string } {
    if (_cachedShell) return _cachedShell;

    // Windows: prefer Git for Windows bash, fall back to bare `bash` so the
    // error message is clear ("bash not found") rather than an opaque cmd.exe
    // syntax failure.
    _cachedShell = resolvePosixShell() ?? { shell: "bash", flag: "-c" };
    return _cachedShell;
}

/**
 * Reset the cached shell — only needed for testing.
 * @internal
 */
export function _resetShellCache(): void {
    _cachedShell = undefined;
}

/** Run a single hook script, piping JSON payload on stdin. */
export async function runHook(
    entry: HookEntry,
    payload: string,
    cwd: string,
    _spawnImpl?: SpawnLike,
): Promise<HookResult> {
    const hookTimeout = entry.timeout ?? 10_000;

    const { shell, flag } = resolveShell();
    const spawnFn = _spawnImpl ?? (Bun.spawn as unknown as SpawnLike);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const proc = spawnFn([shell, flag, expandVars(entry.command)], {
            cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, PIZZAPI_PROJECT_DIR: cwd },
        });

        // Write the JSON payload on stdin
        proc.stdin.write(payload);
        proc.stdin.end();

        // Race the process exit against a timeout
        const exitCode = await Promise.race([
            proc.exited,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    proc.kill(9); // SIGKILL
                    reject(new Error("__hook_timeout__"));
                }, hookTimeout);
            }),
        ]);

        // Process exited normally — cancel the timeout
        clearTimeout(timer);

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        const killed = timedOut || proc.signalCode !== null;
        return {
            exitCode: killed ? (exitCode ?? 124) : (exitCode ?? 0),
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            killed,
        };
    } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.message === "__hook_timeout__") {
            return { exitCode: 124, stdout: "", stderr: "", killed: true };
        }
        return {
            exitCode: 1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            killed: false,
        };
    }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Parse the JSON output from a hook script, extracting additionalContext etc. */
export function parseHookOutput(stdout: string): HookOutput | null {
    if (!stdout) return null;
    try {
        const parsed = JSON.parse(stdout);
        // Support nested hookSpecificOutput (Claude Code format) or flat format
        const specific = parsed.hookSpecificOutput ?? parsed;
        return {
            additionalContext: specific.additionalContext,
            permissionDecision: specific.permissionDecision,
            decision: specific.decision ?? parsed.decision,
            // PreToolUse rewrite fields
            updatedInput: specific.updatedInput,
            // Input hook fields
            text: specific.text,
            action: specific.action,
            // BeforeAgentStart hook fields
            systemPrompt: specific.systemPrompt,
        };
    } catch {
        return null;
    }
}
