import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, normalize } from "node:path";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";

const execFileAsync = promisify(execFile);

// ── Validation helpers ──────────────────────────────────────────────────────

/** Validate that a branch name doesn't contain shell-dangerous characters. */
function isValidBranchName(name: string): boolean {
    if (!name || name.length > 256) return false;
    // Reject control chars, space-only, "..", "~", "^", ":", "\\", NUL
    if (/[\x00-\x1f\x7f~^:\\]/.test(name)) return false;
    if (name.includes("..")) return false;
    if (name.includes("@{")) return false;
    if (name.endsWith(".lock") || name.endsWith(".") || name.endsWith("/") || name.startsWith("/")) return false;
    return true;
}

/** Validate that file paths don't attempt path traversal. */
function isValidPath(p: string): boolean {
    if (!p) return false;
    const norm = normalize(p);
    // Reject absolute paths
    if (norm.startsWith("/") || norm.startsWith("\\")) return false;
    // Reject path traversal by checking segments — allows valid filenames
    // like "foo..bar.ts" while blocking "../" traversal.
    const segments = norm.split(/[/\\]/);
    if (segments.some((s) => s === "..")) return false;
    return true;
}

// ── GitService ──────────────────────────────────────────────────────────────

export class GitService implements ServiceHandler {
    readonly id = "git";

    private _socket: Socket | null = null;
    private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;
    private _isShuttingDown: () => boolean = () => false;

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this._socket = socket;
        this._isShuttingDown = isShuttingDown;

        this._onServiceMessage = (envelope: ServiceEnvelope) => {
            if (isShuttingDown()) return;
            if (envelope.serviceId !== "git") return;

            const payload = (envelope.payload ?? {}) as Record<string, unknown>;
            const requestId = envelope.requestId;
            const sessionId = envelope.sessionId;

            switch (envelope.type) {
                case "git_status":
                    void this.handleStatus(payload, requestId, sessionId);
                    break;
                case "git_diff":
                    void this.handleDiff(payload, requestId, sessionId);
                    break;
                case "git_branches":
                    void this.handleBranches(payload, requestId, sessionId);
                    break;
                case "git_checkout":
                    void this.handleCheckout(payload, requestId, sessionId);
                    break;
                case "git_stage":
                    void this.handleStage(payload, requestId, sessionId);
                    break;
                case "git_unstage":
                    void this.handleUnstage(payload, requestId, sessionId);
                    break;
                case "git_commit":
                    void this.handleCommit(payload, requestId, sessionId);
                    break;
                case "git_push":
                    void this.handlePush(payload, requestId, sessionId);
                    break;
            }
        };

        (socket as any).on("service_message", this._onServiceMessage);
    }

    dispose(): void {
        if (this._socket && this._onServiceMessage) {
            (this._socket as any).off("service_message", this._onServiceMessage);
        }
        this._socket = null;
        this._onServiceMessage = null;
    }

    // ── Response helper ─────────────────────────────────────────────────

    private emit(type: string, payload: Record<string, unknown>, requestId?: string, sessionId?: string): void {
        if (!this._socket) return;
        const envelope: ServiceEnvelope & { sessionId?: string } = {
            serviceId: "git",
            type,
            payload,
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
        };
        (this._socket as any).emit("service_message", envelope);
    }

    private emitError(type: string, message: string, requestId?: string, sessionId?: string): void {
        this.emit(type, { ok: false, message }, requestId, sessionId);
    }

    // ── cwd validation ──────────────────────────────────────────────────

    private validateCwd(cwd: unknown, responseType: string, requestId?: string, sessionId?: string): string | null {
        if (typeof cwd !== "string" || !cwd) {
            this.emitError(responseType, "Missing cwd", requestId, sessionId);
            return null;
        }
        if (!isCwdAllowed(cwd)) {
            this.emitError(responseType, "Path outside allowed roots", requestId, sessionId);
            return null;
        }
        return cwd;
    }

    // ── git status ──────────────────────────────────────────────────────

    private async handleStatus(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_status_result", requestId, sessionId);
        if (!cwd) return;

        try {
            const [branchResult, toplevelResult, statusResult, diffStagedResult, abResult] = await Promise.allSettled([
                execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }),
                execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 }),
                // Use -z for NUL-delimited output — avoids C-quoting of filenames
                // with spaces/special chars and makes parsing unambiguous.
                execFileAsync("git", ["status", "--porcelain=v1", "-uall", "-z"], { cwd, timeout: 10000 }),
                execFileAsync("git", ["diff", "--cached", "--stat"], { cwd, timeout: 10000 }),
                execFileAsync("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd, timeout: 5000 }),
            ]);

            const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
            const repoRoot = toplevelResult.status === "fulfilled" ? toplevelResult.value.stdout.trim() : cwd;
            const statusOutput = statusResult.status === "fulfilled" ? statusResult.value.stdout : "";
            const diffStaged = diffStagedResult.status === "fulfilled" ? diffStagedResult.value.stdout : "";

            // Parse porcelain v1 -z output (NUL-delimited).
            // Format: XY PATH\0 (for renames: XY ORIG\0NEW\0)
            // IMPORTANT: preserve the raw 2-char XY status (e.g. " M", "M ", "MM", "??").
            const changes: Array<{ status: string; path: string; originalPath?: string }> = [];
            const entries = statusOutput.split("\0");
            let i = 0;
            while (i < entries.length) {
                const entry = entries[i];
                if (!entry || entry.length < 3) { i++; continue; }
                const xy = entry.substring(0, 2);
                const path = entry.substring(3);
                // Renames (R/C) have a second NUL-delimited field for the new path
                if (xy[0] === "R" || xy[0] === "C") {
                    const newPath = entries[i + 1] ?? path;
                    changes.push({ status: xy, path: newPath, originalPath: path });
                    i += 2;
                } else {
                    changes.push({ status: xy, path });
                    i++;
                }
            }

            let ahead = 0;
            let behind = 0;
            // If rev-list against @{u} failed, the branch has no upstream
            const hasUpstream = abResult.status === "fulfilled";
            if (hasUpstream) {
                const [a, b] = abResult.value.stdout.trim().split(/\s+/);
                ahead = parseInt(a, 10) || 0;
                behind = parseInt(b, 10) || 0;
            }

            this.emit("git_status_result", {
                ok: true,
                branch,
                repoRoot,
                changes,
                ahead,
                behind,
                hasUpstream,
                diffStaged,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_status_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git diff ────────────────────────────────────────────────────────

    private async handleDiff(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_diff_result", requestId, sessionId);
        if (!cwd) return;

        const filePath = typeof payload.path === "string" ? payload.path : "";
        const staged = payload.staged === true;

        if (!filePath) {
            this.emitError("git_diff_result", "Missing path", requestId, sessionId);
            return;
        }

        try {
            // Resolve repo root — paths from git status are repo-root-relative,
            // so diff must run from repo root for paths to resolve correctly.
            const { stdout: toplevel } = await execFileAsync(
                "git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 },
            );
            const repoRoot = toplevel.trim() || cwd;

            const args = staged
                ? ["diff", "--cached", "--", filePath]
                : ["diff", "--", filePath];
            const { stdout: diff } = await execFileAsync("git", args, { cwd: repoRoot, timeout: 10000 });
            this.emit("git_diff_result", { ok: true, diff }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_diff_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git branches ────────────────────────────────────────────────────

    private async handleBranches(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_branches_result", requestId, sessionId);
        if (!cwd) return;

        try {
            // Get current branch
            const { stdout: currentBranch } = await execFileAsync(
                "git", ["rev-parse", "--abbrev-ref", "HEAD"],
                { cwd, timeout: 5000 },
            );

            // Use for-each-ref for reliable branch listing with ref-type awareness.
            // List local branches from refs/heads and remote branches from refs/remotes,
            // excluding remote HEAD aliases (e.g. refs/remotes/origin/HEAD).
            const [localResult, remoteResult] = await Promise.allSettled([
                execFileAsync(
                    "git",
                    ["for-each-ref", "--sort=-committerdate",
                     "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)\t%(HEAD)",
                     "refs/heads"],
                    { cwd, timeout: 10000 },
                ),
                execFileAsync(
                    "git",
                    ["for-each-ref", "--sort=-committerdate",
                     "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)",
                     "refs/remotes", "--exclude=refs/remotes/*/HEAD"],
                    { cwd, timeout: 10000 },
                ),
            ]);

            const branches: Array<{
                name: string;
                shortHash: string;
                lastCommit: string;
                isCurrent: boolean;
                isRemote: boolean;
            }> = [];

            // Parse local branches
            const localOutput = localResult.status === "fulfilled" ? localResult.value.stdout : "";
            for (const line of localOutput.split("\n")) {
                if (!line.trim()) continue;
                const [name, shortHash, lastCommit, head] = line.split("\t");
                if (!name) continue;
                branches.push({
                    name: name.trim(),
                    shortHash: shortHash?.trim() ?? "",
                    lastCommit: lastCommit?.trim() ?? "",
                    isCurrent: head?.trim() === "*",
                    isRemote: false,
                });
            }

            // Parse remote branches
            const remoteOutput = remoteResult.status === "fulfilled" ? remoteResult.value.stdout : "";
            for (const line of remoteOutput.split("\n")) {
                if (!line.trim()) continue;
                const [name, shortHash, lastCommit] = line.split("\t");
                if (!name) continue;
                branches.push({
                    name: name.trim(),
                    shortHash: shortHash?.trim() ?? "",
                    lastCommit: lastCommit?.trim() ?? "",
                    isCurrent: false,
                    isRemote: true,
                });
            }

            this.emit("git_branches_result", {
                ok: true,
                currentBranch: currentBranch.trim(),
                branches,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_branches_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git checkout ────────────────────────────────────────────────────

    private async handleCheckout(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_checkout_result", requestId, sessionId);
        if (!cwd) return;

        const branch = typeof payload.branch === "string" ? payload.branch : "";
        if (!branch || !isValidBranchName(branch)) {
            this.emitError("git_checkout_result", "Invalid branch name", requestId, sessionId);
            return;
        }

        // The UI passes isRemote explicitly based on which section the user
        // clicked (local vs remote). This avoids name heuristics that misclassify
        // local branches like "feature/foo" when a remote named "feature" exists.
        const isRemote = payload.isRemote === true;

        try {
            let targetBranch = branch;
            const args: string[] = [];

            if (isRemote) {
                // Remote branch: extract local name from "remote/branch" and create tracking branch
                const slashIdx = branch.indexOf("/");
                if (slashIdx > 0) {
                    targetBranch = branch.substring(slashIdx + 1);
                }
                // Check if a local branch with this name already exists
                try {
                    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${targetBranch}`], { cwd, timeout: 5000 });
                    // Local branch exists, just check it out
                    args.push("checkout", targetBranch);
                } catch {
                    // No local branch — create tracking branch
                    args.push("checkout", "-b", targetBranch, branch);
                }
            } else {
                // Local branch — check out directly
                args.push("checkout", targetBranch);
            }

            await execFileAsync("git", args, { cwd, timeout: 15000 });

            this.emit("git_checkout_result", {
                ok: true,
                branch: targetBranch,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_checkout_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git stage ───────────────────────────────────────────────────────

    private async handleStage(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_stage_result", requestId, sessionId);
        if (!cwd) return;

        const all = payload.all === true;
        const paths = Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === "string") : [];

        if (!all && paths.length === 0) {
            this.emitError("git_stage_result", "No paths specified and all is false", requestId, sessionId);
            return;
        }

        // Validate individual paths
        if (!all) {
            for (const p of paths) {
                if (!isValidPath(p)) {
                    this.emitError("git_stage_result", `Invalid path: ${p}`, requestId, sessionId);
                    return;
                }
            }
        }

        try {
            // Resolve repo root — paths from git status are repo-root-relative,
            // so operations must run from repo root for paths to resolve correctly.
            const { stdout: toplevel } = await execFileAsync(
                "git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 },
            );
            const repoRoot = toplevel.trim() || cwd;

            const args = all ? ["add", "--all"] : ["add", "--", ...paths];
            await execFileAsync("git", args, { cwd: repoRoot, timeout: 15000 });
            this.emit("git_stage_result", { ok: true }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_stage_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git unstage ─────────────────────────────────────────────────────

    private async handleUnstage(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_unstage_result", requestId, sessionId);
        if (!cwd) return;

        const all = payload.all === true;
        const paths = Array.isArray(payload.paths) ? payload.paths.filter((p): p is string => typeof p === "string") : [];

        if (!all && paths.length === 0) {
            this.emitError("git_unstage_result", "No paths specified and all is false", requestId, sessionId);
            return;
        }

        if (!all) {
            for (const p of paths) {
                if (!isValidPath(p)) {
                    this.emitError("git_unstage_result", `Invalid path: ${p}`, requestId, sessionId);
                    return;
                }
            }
        }

        try {
            // Resolve repo root — run from there so repo-root-relative paths work.
            // For unstage-all, use ":/" pathspec (magic "repo root") instead of "."
            // which would only cover the cwd subtree.
            const { stdout: toplevel } = await execFileAsync(
                "git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 },
            );
            const repoRoot = toplevel.trim() || cwd;

            const args = all
                ? ["restore", "--staged", ":/"]
                : ["restore", "--staged", "--", ...paths];
            await execFileAsync("git", args, { cwd: repoRoot, timeout: 15000 });
            this.emit("git_unstage_result", { ok: true }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_unstage_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git commit ──────────────────────────────────────────────────────

    private async handleCommit(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_commit_result", requestId, sessionId);
        if (!cwd) return;

        const message = typeof payload.message === "string" ? payload.message.trim() : "";
        if (!message) {
            this.emitError("git_commit_result", "Empty commit message", requestId, sessionId);
            return;
        }

        try {
            const { stdout } = await execFileAsync(
                "git", ["commit", "-m", message],
                { cwd, timeout: 30000 },
            );

            // Parse the short summary (e.g. "[main abc1234] Fix thing\n 1 file changed...")
            const firstLine = stdout.split("\n")[0] ?? "";

            this.emit("git_commit_result", {
                ok: true,
                summary: firstLine.trim(),
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_commit_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git push ────────────────────────────────────────────────────────

    private async handlePush(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_push_result", requestId, sessionId);
        if (!cwd) return;

        const setUpstream = payload.setUpstream === true;

        try {
            // Determine current branch for --set-upstream
            const { stdout: branchName } = await execFileAsync(
                "git", ["rev-parse", "--abbrev-ref", "HEAD"],
                { cwd, timeout: 5000 },
            );
            const branch = branchName.trim();

            let args: string[];
            if (setUpstream) {
                // Resolve the default remote dynamically instead of hardcoding "origin".
                // Try the configured push remote, then fall back to the first remote.
                let remote = "origin";
                try {
                    const { stdout } = await execFileAsync(
                        "git", ["config", "--get", `branch.${branch}.remote`],
                        { cwd, timeout: 5000 },
                    );
                    if (stdout.trim()) remote = stdout.trim();
                } catch {
                    // No tracked remote — try first remote in list
                    try {
                        const { stdout } = await execFileAsync(
                            "git", ["remote"],
                            { cwd, timeout: 5000 },
                        );
                        const firstRemote = stdout.trim().split("\n")[0]?.trim();
                        if (firstRemote) remote = firstRemote;
                    } catch { /* fall through to "origin" */ }
                }
                args = ["push", "--set-upstream", remote, branch];
            } else {
                args = ["push"];
            }

            // git push writes to stderr (progress), use a larger timeout for network ops
            const result = await execFileAsync("git", args, { cwd, timeout: 60000 });
            const output = (result.stdout + "\n" + result.stderr).trim();

            this.emit("git_push_result", {
                ok: true,
                output,
            }, requestId, sessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Detect "no upstream" and hint the user
            const noUpstream = message.includes("has no upstream branch") || message.includes("--set-upstream");
            this.emit("git_push_result", {
                ok: false,
                message,
                noUpstream,
            }, requestId, sessionId);
        }
    }
}
