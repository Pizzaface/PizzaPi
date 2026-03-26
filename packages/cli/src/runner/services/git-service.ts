import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";

const execFileAsync = promisify(execFile);

export class GitService implements ServiceHandler {
    readonly id = "git";

    // Socket reference and named handler refs — kept so dispose() can call
    // socket.off() with the exact same function object that was passed to
    // socket.on().  Without this, each reconnect would add a new listener
    // while the old one stayed registered (listener leak).
    private _socket: Socket | null = null;
    private _onGitStatus: ((data: any) => void) | null = null;
    private _onGitDiff: ((data: any) => void) | null = null;

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this._socket = socket;

        // Helper: emit file_result on both channels (direct + service envelope).
        // ALL file_result emissions in this service go through this helper so
        // error paths and success paths are both covered.
        const emitFileResult = (payload: Record<string, unknown>) => {
            socket.emit("file_result" as any, payload);
            (socket as any).emit("service_message", {
                serviceId: "git",
                type: "file_result",
                payload,
            });
        };

        this._onGitStatus = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            if (!cwd) {
                emitFileResult({ requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                emitFileResult({ requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                // Run all git commands asynchronously to avoid blocking the
                // event loop (which would prevent Socket.IO pings from being
                // answered, causing spurious disconnects).
                const [branchResult, statusResult, diffStagedResult, abResult] = await Promise.allSettled([
                    execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }),
                    execFileAsync("git", ["status", "--porcelain=v1", "-uall"], { cwd, timeout: 10000 }),
                    execFileAsync("git", ["diff", "--cached", "--stat"], { cwd, timeout: 10000 }),
                    execFileAsync("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd, timeout: 5000 }),
                ]);

                const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
                const statusOutput = statusResult.status === "fulfilled" ? statusResult.value.stdout : "";
                const diffStaged = diffStagedResult.status === "fulfilled" ? diffStagedResult.value.stdout : "";

                // Parse porcelain output
                const changes: Array<{ status: string; path: string; originalPath?: string }> = [];
                for (const line of statusOutput.split("\n")) {
                    if (!line.trim()) continue;
                    const xy = line.substring(0, 2);
                    const rest = line.substring(3);
                    // Handle renames: "R  old -> new"
                    const arrowIdx = rest.indexOf(" -> ");
                    if (arrowIdx >= 0) {
                        changes.push({
                            status: xy.trim(),
                            path: rest.substring(arrowIdx + 4),
                            originalPath: rest.substring(0, arrowIdx),
                        });
                    } else {
                        changes.push({ status: xy.trim(), path: rest });
                    }
                }

                // Get ahead/behind counts
                let ahead = 0;
                let behind = 0;
                if (abResult.status === "fulfilled") {
                    const abOutput = abResult.value.stdout.trim();
                    const [a, b] = abOutput.split(/\s+/);
                    ahead = parseInt(a, 10) || 0;
                    behind = parseInt(b, 10) || 0;
                }

                emitFileResult({
                    requestId,
                    ok: true,
                    branch,
                    changes,
                    ahead,
                    behind,
                    diffStaged,
                });
            } catch (err) {
                emitFileResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        socket.on("git_status", this._onGitStatus);

        this._onGitDiff = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            const filePath = (data as any).path ?? "";
            const staged = (data as any).staged === true;

            if (!cwd || !filePath) {
                emitFileResult({ requestId, ok: false, message: "Missing cwd or path" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                emitFileResult({ requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
                const { stdout: diff } = await execFileAsync("git", args, { cwd, timeout: 10000 });
                emitFileResult({ requestId, ok: true, diff });
            } catch (err) {
                emitFileResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        socket.on("git_diff", this._onGitDiff);
    }

    dispose(): void {
        // Remove all socket listeners registered by init() so that reconnects
        // don't accumulate N+1 handlers per event.
        if (this._socket) {
            if (this._onGitStatus) (this._socket as any).off("git_status", this._onGitStatus);
            if (this._onGitDiff) (this._socket as any).off("git_diff", this._onGitDiff);
            this._socket = null;
        }
        this._onGitStatus = null;
        this._onGitDiff = null;
    }
}
