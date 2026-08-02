import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import { isCwdAllowed, getWorkspaceRoots } from "../workspace.js";

// Sensitive dotfolders that should never appear in the folder browser
// when browsing outside configured workspace roots.
const SENSITIVE_DOTDIRS = new Set([
    ".ssh", ".gnupg", ".gpg", ".aws", ".docker", ".kube",
    ".config", ".local", ".cache", ".npm", ".bun",
]);

const execFileAsync = promisify(execFile);

export class FileExplorerService implements ServiceHandler {
    readonly id = "file-explorer";

    // Socket reference and named handler refs — kept so dispose() can call
    // socket.off() with the exact same function object that was passed to
    // socket.on().  Without this, each reconnect would add a new listener
    // while the old one stayed registered (listener leak).
    private _socket: Socket | null = null;
    private _onListFiles: ((data: any) => void) | null = null;
    private _onSearchFiles: ((data: any) => void) | null = null;
    private _onReadFile: ((data: any) => void) | null = null;
    private _onCancelFileRequest: ((data: any) => void) | null = null;
    private _onBrowseDirectory: ((data: any) => void) | null = null;
    private _activeReadRequests = new Map<string, AbortController>();

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this._socket = socket;

        // REST reads use only the correlated direct response so file content
        // is never broadcast to unrelated session viewers.
        const emitFileResult = (payload: Record<string, unknown>, broadcast = true) => {
            socket.emit("file_result" as any, payload);
            if (broadcast) {
                (socket as any).emit("service_message", {
                    serviceId: "file-explorer",
                    type: "file_result",
                    payload,
                });
            }
        };

        this._onListFiles = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const dirPath = data.path ?? "";
            if (!dirPath) {
                emitFileResult({ requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(dirPath)) {
                emitFileResult({ requestId, ok: false, message: "Path outside allowed roots" });
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
                emitFileResult({ requestId, ok: true, files: items });
            } catch (err) {
                emitFileResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        socket.on("list_files", this._onListFiles);

        // browse_directory — lists only subdirectories at a given path (for folder picker UI)
        this._onBrowseDirectory = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const dirPath = data.path ?? "";
            if (!dirPath) {
                emitFileResult({ requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(dirPath)) {
                emitFileResult({ requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const entries = await readdir(dirPath, { withFileTypes: true });

                // Determine if we're inside a workspace root (if any are configured).
                // When outside roots, filter sensitive dotfolders for safety.
                const roots = getWorkspaceRoots();
                const insideRoot = roots.length === 0 || roots.some((root) => {
                    const nRoot = root.replace(/\/+$/, "") || "/";
                    const nDir = dirPath.replace(/\/+$/, "") || "/";
                    return nDir === nRoot || nDir.startsWith(nRoot + "/");
                });

                // Resolve entries: include directories and symlinks-to-directories
                const dirResults: { name: string; path: string }[] = [];
                for (const e of entries) {
                    // Always skip .git and node_modules
                    if (e.name === ".git" || e.name === "node_modules") continue;
                    // Filter sensitive dotfolders when outside workspace roots
                    if (!insideRoot && SENSITIVE_DOTDIRS.has(e.name)) continue;

                    const fullPath = join(dirPath, e.name);

                    if (e.isDirectory()) {
                        dirResults.push({ name: e.name, path: fullPath });
                    } else if (e.isSymbolicLink()) {
                        // Resolve symlink to check if it points to a directory
                        try {
                            const resolved = await realpath(fullPath);
                            const s = await stat(resolved);
                            if (s.isDirectory()) {
                                dirResults.push({ name: e.name, path: fullPath });
                            }
                        } catch {
                            // Broken symlink or permission error — skip
                        }
                    }
                }

                dirResults.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
                emitFileResult({ requestId, ok: true, directories: dirResults });
            } catch (err) {
                emitFileResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        socket.on("browse_directory", this._onBrowseDirectory);

        this._onSearchFiles = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const cwd = (data as any).cwd ?? "";
            const query = (data as any).query ?? "";
            const limit = typeof (data as any).limit === "number" ? (data as any).limit : 100;

            if (!cwd) {
                emitFileResult({ requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                emitFileResult({ requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            if (!query) {
                emitFileResult({ requestId, ok: true, files: [] });
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
                emitFileResult({ requestId, ok: true, files });
            } catch (err) {
                // If git fails (not a git repo, etc.), return empty list
                const isGitError = err instanceof Error && (err as any).code !== undefined;
                if (isGitError) {
                    emitFileResult({ requestId, ok: true, files: [] });
                    return;
                }
                emitFileResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        socket.on("search_files", this._onSearchFiles);

        this._onReadFile = async (data: any) => {
            if (isShuttingDown()) return;
            const requestId = data.requestId;
            const filePath = data.path ?? "";
            const encoding = (data as any).encoding ?? "utf8";
            const maxBytes = typeof (data as any).maxBytes === "number"
                ? (data as any).maxBytes
                : encoding === "base64"
                    ? 10 * 1024 * 1024
                    : 256 * 1024; // 10MB for base64, 256KB for text
            const controller = new AbortController();
            if (typeof requestId === "string") {
                this._activeReadRequests.get(requestId)?.abort();
                this._activeReadRequests.set(requestId, controller);
            }
            const emitReadResult = (payload: Record<string, unknown>) => {
                if (!controller.signal.aborted) emitFileResult(payload, false);
            };

            try {
                if (!filePath) {
                    emitReadResult({ requestId, ok: false, message: "Missing path" });
                    return;
                }
                if (!isCwdAllowed(filePath)) {
                    emitReadResult({ requestId, ok: false, message: "Path outside allowed roots" });
                    return;
                }

                const s = await stat(filePath);
                if (controller.signal.aborted) return;
                if (s.size > maxBytes && (data as any).rejectTruncated === true) {
                    emitReadResult({ requestId, ok: true, size: s.size, truncated: true });
                    return;
                }

                const bytes = Buffer.from(await Bun.file(filePath).slice(0, maxBytes + 1).arrayBuffer());
                const finalSize = (await stat(filePath)).size;
                if (controller.signal.aborted) return;
                const truncated = finalSize > maxBytes || bytes.byteLength > maxBytes;
                if (truncated && (data as any).rejectTruncated === true) {
                    emitReadResult({ requestId, ok: true, size: finalSize, truncated: true });
                    return;
                }

                const content = bytes.subarray(0, maxBytes);
                emitReadResult({
                    requestId,
                    ok: true,
                    content: encoding === "base64" ? content.toString("base64") : content.toString("utf8"),
                    ...(encoding === "base64" ? { encoding: "base64" } : {}),
                    size: finalSize,
                    truncated,
                });
            } catch (err) {
                emitReadResult({
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            } finally {
                if (typeof requestId === "string" && this._activeReadRequests.get(requestId) === controller) {
                    this._activeReadRequests.delete(requestId);
                }
            }
        };
        socket.on("read_file", this._onReadFile);

        this._onCancelFileRequest = (data: any) => {
            if (typeof data?.requestId === "string") {
                this._activeReadRequests.get(data.requestId)?.abort();
            }
        };
        socket.on("cancel_file_request" as any, this._onCancelFileRequest);
    }

    dispose(): void {
        // Remove all socket listeners registered by init() so that reconnects
        // don't accumulate N+1 handlers per event.
        if (this._socket) {
            if (this._onListFiles) (this._socket as any).off("list_files", this._onListFiles);
            if (this._onSearchFiles) (this._socket as any).off("search_files", this._onSearchFiles);
            if (this._onReadFile) (this._socket as any).off("read_file", this._onReadFile);
            if (this._onCancelFileRequest) (this._socket as any).off("cancel_file_request", this._onCancelFileRequest);
            if (this._onBrowseDirectory) (this._socket as any).off("browse_directory", this._onBrowseDirectory);
            this._socket = null;
        }
        this._onListFiles = null;
        this._onSearchFiles = null;
        this._onReadFile = null;
        this._onCancelFileRequest = null;
        this._onBrowseDirectory = null;
        for (const controller of this._activeReadRequests.values()) controller.abort();
        this._activeReadRequests.clear();
    }
}
