import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { logInfo } from "../logger.js";
import {
    sessionProcFilePath,
    readRecordedGroupPids,
    pruneProcFile,
    selectGroupProcesses,
    parsePsFullLine,
    type SessionProcess,
} from "../session-procs.js";

const execFileAsync = promisify(execFile);

export type { SessionProcess };

/** Parse one `ps -o pid=,etime=,rss=,command=` output line (legacy helper). */
export function parsePsLine(line: string): SessionProcess | null {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return null;
    return { pid: parseInt(m[1], 10), etime: m[2], rssKb: parseInt(m[3], 10), command: m[4] };
}

/**
 * Lists and kills OS processes belonging to a session.
 *
 * A session's processes span multiple process groups: the worker's own group
 * (PGID = worker PID, holds inline children like MCP stdio servers) plus one
 * group per bash command (the pi bash tool spawns each command detached, so it
 * becomes its own group leader). Command group-leader PIDs are recorded at
 * spawn time into a per-session pid file (see session-procs.ts), which lets us
 * also enumerate — and kill — background processes that reparented to init.
 */
export class ProcessService implements ServiceHandler {
    readonly id = "process";

    private socket: Socket | null = null;
    private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;

    constructor(
        private getWorkerPid: (sessionId: string) => number | null,
        private getProcFilePath: (sessionId: string) => string = sessionProcFilePath,
    ) {}

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this.socket = socket;

        this._onServiceMessage = (envelope: ServiceEnvelope) => {
            if (isShuttingDown()) return;
            if (envelope.serviceId !== "process") return;

            switch (envelope.type) {
                case "process_list":
                    void this.handleList(envelope);
                    break;
                case "process_kill":
                    void this.handleKill(envelope);
                    break;
            }
        };

        (socket as any).on("service_message", this._onServiceMessage);
    }

    dispose(): void {
        if (this.socket && this._onServiceMessage) {
            (this.socket as any).off("service_message", this._onServiceMessage);
        }
        this.socket = null;
        this._onServiceMessage = null;
    }

    /**
     * Process groups belonging to this session: the worker's own group plus
     * every recorded bash-command group. `workerPid` is null for adopted
     * sessions (no child handle after a daemon restart) — recorded groups from
     * the still-running worker's pid file still apply.
     */
    private sessionGroups(sessionId: string, workerPid: number | null): { groups: Set<number>; filePath: string } {
        const filePath = this.getProcFilePath(sessionId);
        const groups = new Set<number>(readRecordedGroupPids(filePath));
        if (workerPid) groups.add(workerPid);
        return { groups, filePath };
    }

    /** Full `ps` snapshot of every process (pid, pgid, etime, rss, command). */
    private async psSnapshot(): Promise<string> {
        const { stdout } = await execFileAsync("ps", ["-A", "-ww", "-o", "pid=,pgid=,etime=,rss=,command="]);
        return stdout;
    }

    private async listProcesses(sessionId: string, workerPid: number | null): Promise<SessionProcess[]> {
        const { groups, filePath } = this.sessionGroups(sessionId, workerPid);
        if (groups.size === 0) return [];
        let snapshot: string;
        try {
            snapshot = await this.psSnapshot();
        } catch {
            return []; // no ps (e.g. Windows) — process tracking unavailable
        }
        const { processes, liveGroups } = selectGroupProcesses(snapshot, groups);
        // Prune the recorded pid file to groups that still have live members
        // (never drop the worker's own group — it isn't recorded there).
        const liveRecorded = [...liveGroups].filter((g) => g !== workerPid);
        pruneProcFile(filePath, liveRecorded);
        return processes;
    }

    /** All PIDs that belong to this session (members of any session group). */
    private async sessionMemberPids(sessionId: string, workerPid: number | null): Promise<Set<number>> {
        const { groups } = this.sessionGroups(sessionId, workerPid);
        const members = new Set<number>();
        if (groups.size === 0) return members;
        let snapshot: string;
        try {
            snapshot = await this.psSnapshot();
        } catch {
            return members;
        }
        for (const line of snapshot.split("\n")) {
            const p = parsePsFullLine(line);
            if (p && groups.has(p.pgid)) members.add(p.pid);
        }
        return members;
    }

    private emit(type: string, payload: unknown, requestId?: string): void {
        if (!this.socket) return;
        (this.socket as any).emit("service_message", {
            serviceId: "process",
            type,
            ...(requestId ? { requestId } : {}),
            payload,
        } satisfies ServiceEnvelope);
    }

    private resolveSessionId(envelope: ServiceEnvelope): string | null {
        if (typeof envelope.sessionId === "string" && envelope.sessionId) return envelope.sessionId;
        const payload = envelope.payload as Record<string, unknown> | undefined;
        return typeof payload?.sessionId === "string" ? payload.sessionId : null;
    }

    private async handleList(envelope: ServiceEnvelope): Promise<void> {
        const sessionId = this.resolveSessionId(envelope);
        const workerPid = sessionId ? this.getWorkerPid(sessionId) : null;
        const processes = sessionId ? await this.listProcesses(sessionId, workerPid) : [];
        this.emit("process_list_result", { workerPid, processes }, envelope.requestId);
    }

    private async handleKill(envelope: ServiceEnvelope): Promise<void> {
        const sessionId = this.resolveSessionId(envelope);
        const payload = envelope.payload as { pid?: number } | undefined;
        const pid = typeof payload?.pid === "number" ? payload.pid : NaN;
        const workerPid = sessionId ? this.getWorkerPid(sessionId) : null;

        if (!sessionId || !Number.isInteger(pid) || pid <= 0) {
            this.emit("process_error", { error: `Invalid kill request (pid=${payload?.pid})` }, envelope.requestId);
            return;
        }

        // Trust boundary: only allow killing PIDs that are actually members of
        // one of this session's process groups — never arbitrary system PIDs.
        const members = await this.sessionMemberPids(sessionId, workerPid);
        if (!members.has(pid)) {
            this.emit("process_error", { error: `PID ${pid} is not part of session ${sessionId}` }, envelope.requestId);
            return;
        }
        if (pid === workerPid) {
            this.emit("process_error", { error: "Refusing to kill the session worker — use Kill Session instead" }, envelope.requestId);
            return;
        }

        try {
            process.kill(pid, "SIGTERM");
            logInfo(`[process] killed pid ${pid} in session ${sessionId}`);
        } catch {
            // Already exited — fall through to refreshed list
        }
        // Respond with a fresh list so the panel updates immediately.
        const processes = await this.listProcesses(sessionId, workerPid);
        this.emit("process_list_result", { workerPid, processes }, envelope.requestId);
    }
}
