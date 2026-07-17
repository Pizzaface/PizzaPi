import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const POLL_MS = 5000;

export interface GroupProcess {
    pid: number;
    etime: string;
    rssKb: number;
    command: string;
}

/**
 * OS processes in this session's process group.
 * Runner workers are spawned detached (PGID = worker PID); local TUI sessions
 * get their own group from shell job control. Either way, everything this
 * session spawned (bash children, MCP stdio servers, dev servers) is here.
 */
export async function listOwnGroupProcesses(): Promise<GroupProcess[]> {
    // pgrep translates group 0 into the caller's own process group and
    // never reports itself; ps runs after pgrep exits so neither shows up.
    const { stdout: pidsOut } = await execFileAsync("pgrep", ["-g", "0"]);
    const pids = pidsOut.split("\n").map((l) => l.trim()).filter(Boolean);
    if (pids.length === 0) return [];
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,etime=,rss=,command=", "-p", pids.join(",")]);
    const procs: GroupProcess[] = [];
    for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        procs.push({ pid: parseInt(m[1], 10), etime: m[2], rssKb: parseInt(m[3], 10), command: m[4] });
    }
    return procs;
}

/** Short display name for a process (basename of argv[0] + first arg). */
export function shortCommand(command: string): string {
    const parts = command.trim().split(/\s+/);
    const bin = parts[0]?.split("/").pop() ?? "?";
    const arg = parts[1] && !parts[1].startsWith("-") ? ` ${parts[1].split("/").pop()}` : "";
    return `${bin}${arg}`;
}

/** One-line widget summary, or null when the session has no child processes. */
export function formatWidgetLine(procs: GroupProcess[], selfPid: number, maxShown = 4): string | null {
    const children = procs.filter((p) => p.pid !== selfPid);
    if (children.length === 0) return null;
    const shown = children.slice(0, maxShown).map((p) => `${shortCommand(p.command)}:${p.pid}`);
    const more = children.length > maxShown ? ` +${children.length - maxShown}` : "";
    return `⚙ ${children.length} proc${children.length === 1 ? "" : "s"} ${shown.join(" · ")}${more}`;
}

/**
 * Live widget above the editor showing every process spawned by this session.
 * Hidden when the session has no child processes.
 */
export const sessionProcessesExtension: ExtensionFactory = (pi) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastLine: string | null | undefined;

    pi.on("session_start", (_event, ctx: any) => {
        if (!ctx.hasUI || timer) return;

        const update = async () => {
            let line: string | null;
            try {
                line = formatWidgetLine(await listOwnGroupProcesses(), process.pid);
            } catch {
                line = null; // no pgrep/ps (e.g. Windows) — stay hidden
            }
            if (line === lastLine) return;
            lastLine = line;
            ctx.ui.setWidget("session-processes", line === null ? undefined : [ctx.ui.theme.fg("dim", line)]);
        };

        void update();
        timer = setInterval(() => void update(), POLL_MS);
    });

    pi.on("session_shutdown", () => {
        if (timer) clearInterval(timer);
        timer = null;
    });
};
