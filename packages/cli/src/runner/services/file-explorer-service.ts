import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";

const execFileAsync = promisify(execFile);

export class FileExplorerService implements ServiceHandler {
    readonly id = "file-explorer";

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        socket.on("list_files", async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const dirPath = data.path ?? "";
            if (!dirPath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(dirPath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const entries = await readdir(dirPath, { withFileTypes: true });
                const items = await Promise.all(
                    entries
                        .filter((e) => {
                            // Show all dotfiles/dotfolders except .git (too noisy)
                            if (e.name === ".git") return false;
                            return true;
                        })
                        .map(async (e) => {
                            const fullPath = join(dirPath, e.name);
                            let size: number | undefined;
                            try {
                                const s = await stat(fullPath);
                                size = s.size;
                            } catch {}
                            return {
                                name: e.name,
                                path: fullPath,
                                isDirectory: e.isDirectory(),
                                isSymlink: e.isSymbolicLink(),
                                size,
                            };
                        }),
                );
                // Directories first, then files, alphabetically
                items.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
                });
                const listPayload = { requestId, ok: true, files: items };
                socket.emit("file_result", listPayload);
                // Dual-emit via service envelope for Phase 3 UI hooks
                (socket as any).emit("service_message", {
                    serviceId: "file-explorer",
                    type: "file_result",
                    payload: listPayload,
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("search_files", async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const cwd = (data as any).cwd ?? "";
            const query = (data as any).query ?? "";
            const limit = typeof (data as any).limit === "number" ? (data as any).limit : 100;

            if (!cwd) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            if (!query) {
                socket.emit("file_result", { requestId, ok: true, files: [] });
                return;
            }
            try {
                // Use git ls-files to get tracked + untracked-not-ignored files.
                // Use async exec to avoid blocking the event loop (which would
                // prevent Socket.IO pings from being answered).
                const { stdout } = await execFileAsync(
                    "git",
                    ["ls-files", "--cached", "--others", "--exclude-standard"],
                    { cwd, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
                );
                const lowerQuery = query.toLowerCase();
                const files = stdout
                    .split("\n")
                    .filter((line) => {
                        if (!line) return false;
                        return line.toLowerCase().includes(lowerQuery);
                    })
                    .slice(0, limit)
                    .map((relativePath) => ({
                        name: relativePath.split("/").pop() ?? relativePath,
                        path: join(cwd, relativePath),
                        relativePath,
                        isDirectory: false,
                        isSymlink: false,
                    }));
                const searchPayload = { requestId, ok: true, files };
                socket.emit("file_result", searchPayload);
                // Dual-emit via service envelope for Phase 3 UI hooks
                (socket as any).emit("service_message", {
                    serviceId: "file-explorer",
                    type: "file_result",
                    payload: searchPayload,
                });
            } catch (err) {
                // If git fails (not a git repo, etc.), return empty list
                const isGitError = err instanceof Error && (err as any).code !== undefined;
                if (isGitError) {
                    socket.emit("file_result", { requestId, ok: true, files: [] });
                    return;
                }
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("read_file", async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const filePath = data.path ?? "";
            const encoding = (data as any).encoding ?? "utf8";
            const maxBytes = typeof (data as any).maxBytes === "number"
                ? (data as any).maxBytes
                : encoding === "base64"
                    ? 10 * 1024 * 1024
                    : 256 * 1024; // 10MB for base64, 256KB for text

            if (!filePath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(filePath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const s = await stat(filePath);
                const truncated = s.size > maxBytes;
                if (encoding === "base64") {
                    const buf = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
                    const b64 = Buffer.from(buf).toString("base64");
                    const readB64Payload = {
                        requestId,
                        ok: true,
                        content: b64,
                        encoding: "base64",
                        size: s.size,
                        truncated,
                    };
                    socket.emit("file_result", readB64Payload);
                    // Dual-emit via service envelope for Phase 3 UI hooks
                    (socket as any).emit("service_message", {
                        serviceId: "file-explorer",
                        type: "file_result",
                        payload: readB64Payload,
                    });
                } else {
                    const fd = await Bun.file(filePath).slice(0, maxBytes).text();
                    const readTextPayload = {
                        requestId,
                        ok: true,
                        content: fd,
                        size: s.size,
                        truncated,
                    };
                    socket.emit("file_result", readTextPayload);
                    // Dual-emit via service envelope for Phase 3 UI hooks
                    (socket as any).emit("service_message", {
                        serviceId: "file-explorer",
                        type: "file_result",
                        payload: readTextPayload,
                    });
                }
            } catch (err) {
                socket.emit("file_result", {
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
