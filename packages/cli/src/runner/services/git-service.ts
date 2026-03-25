import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";

const execFileAsync = promisify(execFile);

export class GitService implements ServiceHandler {
    readonly id = "git";

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
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

        socket.on("git_status", async (data: any) => {
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
        });

        socket.on("git_diff", async (data: any) => {
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
        });
    }

    dispose(): void {
        // No persistent resources to clean up
    }
}
