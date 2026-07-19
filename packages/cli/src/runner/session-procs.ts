/**
 * Session process tracking helpers.
 *
 * Problem: the pi bash tool spawns every command `detached: true`, so each
 * command becomes its own process-group leader (PGID = command PID) in a new
 * session — NOT the worker's group. Anything a command backgrounds (`foo &`)
 * reparents to init when the wrapper exits but keeps that command's PGID. Such
 * processes are therefore invisible to `pgrep -g <workerPid>` and un-killable
 * via the worker's group, so they never showed in the Processes panel and
 * outlived their session.
 *
 * Fix: capture each command's group-leader PID at spawn time. A shell command
 * prefix (installed on the worker's SettingsManager) appends `$$` — the PID of
 * the `bash -c` process, i.e. the detached group leader — to a per-session pid
 * file every time a command runs. The daemon then enumerates every process
 * whose PGID is the worker's group OR any recorded group, which catches
 * orphaned background processes because they inherit their command's PGID.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

/** Directory holding per-session recorded-group pid files. */
export function sessionProcDir(): string {
    return join(homedir(), ".pizzapi", "session-procs");
}

/** Per-session pid file recording spawned command group-leader PIDs. */
export function sessionProcFilePath(sessionId: string): string {
    // Session IDs are relay-supplied — sanitize to a safe filename.
    const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(sessionProcDir(), `${safe}.pids`);
}

/** Ensure the proc-file directory exists (best-effort). */
export function ensureSessionProcDir(): void {
    try {
        mkdirSync(sessionProcDir(), { recursive: true });
    } catch {
        // best-effort
    }
}

/**
 * Shell command prefix that records the running shell's PID (its detached
 * process-group leader) into $PIZZAPI_SESSION_PROC_FILE. Guarded so it is a
 * no-op when the env var is unset and never fails the user's command.
 * `#pp-proc#` is a sentinel used to strip this line from displayed commands.
 */
export const SHELL_PROC_CAPTURE_PREFIX =
    `{ [ -n "$PIZZAPI_SESSION_PROC_FILE" ] && printf '%s\\n' "$$" >>"$PIZZAPI_SESSION_PROC_FILE"; } 2>/dev/null || true #pp-proc#`;

/** Sentinel marking the end of the capture prefix in a `bash -c` command line. */
const CAPTURE_SENTINEL = "#pp-proc#";

/**
 * Remove the capture prefix from a command line for display. ps renders the
 * embedded newline as an actual newline or `\012`; strip up to and including
 * the sentinel plus any following separator.
 */
export function stripCapturePrefix(command: string): string {
    const idx = command.indexOf(CAPTURE_SENTINEL);
    if (idx === -1) return command;
    let rest = command.slice(idx + CAPTURE_SENTINEL.length);
    // Drop the separator between prefix and the real command (real newline,
    // octal-escaped \012 as ps prints, or a space).
    rest = rest.replace(/^(?:\r?\n|\\012|\s)+/, "");
    return rest.length > 0 ? rest : command.slice(0, idx).trimEnd();
}

/** Read recorded group-leader PIDs from a session's pid file (deduped). */
export function readRecordedGroupPids(filePath: string): number[] {
    let content: string;
    try {
        content = readFileSync(filePath, "utf8");
    } catch {
        return []; // missing file — nothing recorded yet
    }
    return parseRecordedGroupPids(content);
}

/** Parse pid-file contents into a deduped list of positive integers. */
export function parseRecordedGroupPids(content: string): number[] {
    const seen = new Set<number>();
    for (const line of content.split("\n")) {
        const n = parseInt(line.trim(), 10);
        if (Number.isInteger(n) && n > 0) seen.add(n);
    }
    return [...seen];
}

/** Delete a session's pid file (best-effort). */
export function removeSessionProcFile(sessionId: string): void {
    try {
        rmSync(sessionProcFilePath(sessionId), { force: true });
    } catch {
        // best-effort
    }
}

/** Rewrite a pid file with only the still-live group PIDs, bounding growth. */
export function pruneProcFile(filePath: string, livePids: number[]): void {
    try {
        if (livePids.length === 0) {
            rmSync(filePath, { force: true });
            return;
        }
        writeFileSync(filePath, livePids.join("\n") + "\n");
    } catch {
        // best-effort
    }
}

export interface GroupProc {
    pid: number;
    pgid: number;
    etime: string;
    rssKb: number;
    command: string;
}

export interface SessionProcess {
    pid: number;
    etime: string;
    rssKb: number;
    command: string;
}

/** Parse one `ps -Ao pid=,pgid=,etime=,rss=,command=` line. */
export function parsePsFullLine(line: string): GroupProc | null {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return null;
    return {
        pid: parseInt(m[1], 10),
        pgid: parseInt(m[2], 10),
        etime: m[3],
        rssKb: parseInt(m[4], 10),
        command: stripCapturePrefix(m[5]),
    };
}

/**
 * From a full `ps` snapshot, select processes whose PGID is one of `groups`.
 * Returns the panel shape (pid/etime/rssKb/command) plus the set of PGIDs that
 * still have live members (for pruning the recorded pid file).
 */
export function selectGroupProcesses(
    psOutput: string,
    groups: Set<number>,
): { processes: SessionProcess[]; liveGroups: Set<number> } {
    const processes: SessionProcess[] = [];
    const liveGroups = new Set<number>();
    for (const line of psOutput.split("\n")) {
        const p = parsePsFullLine(line);
        if (!p) continue;
        if (!groups.has(p.pgid)) continue;
        liveGroups.add(p.pgid);
        processes.push({ pid: p.pid, etime: p.etime, rssKb: p.rssKb, command: p.command });
    }
    return { processes, liveGroups };
}
