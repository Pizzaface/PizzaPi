import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { logInfo } from "../logger.js";

const execFileAsync = promisify(execFile);

export interface SessionProcess {
    pid: number;
    /** Elapsed time as reported by ps (e.g. "02:13" or "1-04:00:00"). */
    etime: string;
    /** Resident set size in KB. */
    rssKb: number;
    command: string;
}

/** Parse one `ps -o pid=,etime=,rss=,command=` output line. */
export function parsePsLine(line: string): SessionProcess | null {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) return null;
    return { pid: parseInt(m[1], 10), etime: m[2], rssKb: parseInt(m[3], 10), command: m[4] };
}

/**
 * Lists and kills OS processes belonging to a session's process group.
 * Workers are spawned detached, so PGID = worker PID and every descendant
 * (bash children, MCP stdio servers, dev servers) is enumerable via `pgrep -g`.
 */
export class ProcessService implements ServiceHandler {
    readonly id = "process";

    private socket: Socket | null = null;
    private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;

    constructor(private getWorkerPid: (sessionId: string) => number | null) {}

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

    /** PIDs in the session's process group. Empty when the group is gone. */
    private async groupPids(workerPid: number): Promise<number[]> {
        try {
            const { stdout } = await execFileAsync("pgrep", ["-g", String(workerPid)]);
            return stdout.split("\n").map((l) => parseInt(l, 10)).filter((n) => Number.isFinite(n));
        } catch {
            // pgrep exits 1 when no processes match
            return [];
        }
    }

    private async listProcesses(workerPid: number): Promise<SessionProcess[]> {
        const pids = await this.groupPids(workerPid);
        if (pids.length === 0) return [];
        try {
            const { stdout } = await execFileAsync("ps", ["-o", "pid=,etime=,rss=,command=", "-p", pids.join(",")]);
            return stdout.split("\n").map(parsePsLine).filter((p): p is SessionProcess => p !== null);
        } catch {
            return [];
        }
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
        // workerPid is null for adopted sessions (worker survived a daemon
        // restart — no child handle) and ended sessions. Report an empty list.
        const processes = workerPid ? await this.listProcesses(workerPid) : [];
        this.emit("process_list_result", { workerPid, processes }, envelope.requestId);
    }

    private async handleKill(envelope: ServiceEnvelope): Promise<void> {
        const sessionId = this.resolveSessionId(envelope);
        const payload = envelope.payload as { pid?: number } | undefined;
        const pid = typeof payload?.pid === "number" ? payload.pid : NaN;
        const workerPid = sessionId ? this.getWorkerPid(sessionId) : null;

        if (!workerPid || !Number.isInteger(pid) || pid <= 0) {
            this.emit("process_error", { error: `Invalid kill request (pid=${payload?.pid})` }, envelope.requestId);
            return;
        }

        // Trust boundary: only allow killing PIDs that are actually members of
        // this session's process group — never arbitrary system PIDs.
        const pids = await this.groupPids(workerPid);
        if (!pids.includes(pid)) {
            this.emit("process_error", { error: `PID ${pid} is not part of session ${sessionId}` }, envelope.requestId);
            return;
        }
        if (pid === workerPid) {
            this.emit("process_error", { error: "Refusing to kill the session worker — use Kill Session instead" }, envelope.requestId);
            return;
        }

        try {
            process.kill(pid, "SIGTERM");
            logInfo(`[process] killed pid ${pid} in session ${sessionId} group ${workerPid}`);
        } catch {
            // Already exited — fall through to refreshed list
        }
        // Respond with a fresh list so the panel updates immediately.
        const processes = await this.listProcesses(workerPid);
        this.emit("process_list_result", { workerPid, processes }, envelope.requestId);
    }
}
