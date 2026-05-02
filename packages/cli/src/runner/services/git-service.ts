import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { promisify } from "node:util";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { isCwdAllowed } from "../workspace.js";

const execFileAsync = promisify(execFile);
const STATUS_CACHE_TTL_MS = 2_500;
const METADATA_DEBOUNCE_MS = 300;

type WatchHandle = { close(): void };
type WatchFs = (path: string, listener: () => void) => WatchHandle;
type SetTimeoutFn = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type ClearTimeoutFn = (timeout: ReturnType<typeof setTimeout>) => void;

type GitExec = (
    args: string[],
    options: { cwd: string; timeout: number; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

type GitStatusResultPayload = {
    ok: true;
    cwd: string;
    branch: string;
    repoRoot: string;
    changes: Array<{ status: string; path: string; originalPath?: string }>;
    ahead: number;
    behind: number;
    hasUpstream: boolean;
    diffStaged: string;
};

type GitStatusSnapshot = {
    generation: number;
    payload: GitStatusResultPayload;
};

type GitBranchResultPayload = {
    currentBranch: string;
    branches: Array<{
        name: string;
        shortHash: string;
        lastCommit: string;
        isCurrent: boolean;
        isRemote: boolean;
    }>;
};

type GitWorktreeResultPayload = {
    worktrees: Array<{
        path: string;
        displayPath: string;
        branch: string;
        shortHash: string;
        isDetached: boolean;
        isMain: boolean;
        changeCount: number;
        ahead: number;
        behind: number;
    }>;
};

type RepoWatchState = {
    watchers: WatchHandle[];
    debounceTimer: ReturnType<typeof setTimeout> | null;
    refreshInFlight: boolean;
    needsRefresh: boolean;
};

type GitUpstreamFailureReason = "detachedHead" | "missingUpstream" | "ambiguousUpstream";

type GitUpstreamResolution =
    | {
        ok: true;
        localBranch: string;
        remote: string;
        mergeBranch: string;
        trackingRef: string;
    }
    | {
        ok: false;
        reason: GitUpstreamFailureReason;
        message: string;
        localBranch?: string;
        remote?: string;
        mergeBranches?: string[];
    };

// ── Validation helpers ──────────────────────────────────────────────────────

/** Validate that a branch name doesn't contain shell-dangerous characters. */
function isValidBranchName(name: string): boolean {
    if (!name || name.length > 256) return false;
    // Reject names starting with "-": they are never valid branch refs and
    // would be interpreted as git options (e.g. --abort, --continue).
    if (name.startsWith("-")) return false;
    // Reject control chars, space-only, "..", "~", "^", ":", "\\", NUL
    if (/[\x00-\x1f\x7f~^:\\]/.test(name)) return false;
    if (name.includes("..")) return false;
    if (name.includes("@{")) return false;
    if (name.endsWith(".lock") || name.endsWith(".") || name.endsWith("/") || name.startsWith("/")) return false;
    return true;
}

/** Validate remote names used in git commands/config. */
function isValidRemoteName(name: string): boolean {
    if (!name || name.length > 256) return false;
    if (name.startsWith("-")) return false;
    if (/[^A-Za-z0-9._/-]/.test(name)) return false;
    return true;
}

/** Validate that file paths don't attempt path traversal. */
function isValidPath(p: string): boolean {
    if (!p) return false;
    // Reject Git pathspec magic prefixes (e.g. `:!`, `:/`, `:^`, `:(top)`)
    // which can bypass path-containment checks and select unexpected files.
    if (p.startsWith(":")) return false;
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
    private readonly _execGit: GitExec;
    private readonly _watchFs: WatchFs;
    private readonly _setTimeout: SetTimeoutFn;
    private readonly _clearTimeout: ClearTimeoutFn;
    private readonly _now: () => number;
    private readonly _statusCache = new Map<string, { expiresAt: number; snapshot: GitStatusSnapshot }>();
    private readonly _statusInFlight = new Map<string, Promise<GitStatusSnapshot>>();
    private readonly _statusGeneration = new Map<string, number>();
    private readonly _cwdSubscribers = new Map<string, Set<string>>();
    private readonly _sessionCwd = new Map<string, string>();
    private readonly _repoWatchers = new Map<string, RepoWatchState>();
    /**
     * Mutation lock map: repoRoot → mutation token.
     *
     * Only used for operations that genuinely conflict with each other
     * (checkout, commit, push, pull, merge, rebase, set-upstream).
     * Stage/unstage are NOT locked here — git's own index lock serializes
     * concurrent `git add`/`git restore --staged` safely, and the UI
     * already disables buttons while an operation is in-flight.
     */
    private readonly _activeRepoMutations = new Map<string, string>();

    constructor(options?: {
        execGit?: GitExec;
        watchFs?: WatchFs;
        setTimeoutFn?: SetTimeoutFn;
        clearTimeoutFn?: ClearTimeoutFn;
        now?: () => number;
    }) {
        this._execGit = options?.execGit ?? ((args, execOptions) => execFileAsync("git", args, execOptions));
        this._watchFs = options?.watchFs ?? ((path, listener) => watch(path, { persistent: false }, listener));
        this._setTimeout = options?.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this._clearTimeout = options?.clearTimeoutFn ?? ((timeout) => clearTimeout(timeout));
        this._now = options?.now ?? (() => Date.now());
    }

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
                case "git_full_status":
                    void this.handleFullStatus(payload, requestId, sessionId);
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
                case "git_pull":
                    void this.handlePull(payload, requestId, sessionId);
                    break;
                case "git_merge":
                    void this.handleMerge(payload, requestId, sessionId);
                    break;
                case "git_merge_abort":
                    void this.handleMergeAbort(payload, requestId, sessionId);
                    break;
                case "git_set_upstream":
                    void this.handleSetUpstream(payload, requestId, sessionId);
                    break;
                case "git_worktrees":
                    void this.handleWorktrees(payload, requestId, sessionId);
                    break;
                case "git_rebase":
                    void this.handleRebase(payload, requestId, sessionId);
                    break;
                case "git_rebase_abort":
                    void this.handleRebaseAbort(payload, requestId, sessionId);
                    break;
                case "git_rebase_continue":
                    void this.handleRebaseContinue(payload, requestId, sessionId);
                    break;
                case "git_worktree_add":
                    void this.handleWorktreeAdd(payload, requestId, sessionId);
                    break;
                case "git_worktree_remove":
                    void this.handleWorktreeRemove(payload, requestId, sessionId);
                    break;
            }
        };

        (socket as any).on("service_message", this._onServiceMessage);
    }

    dispose(): void {
        if (this._socket && this._onServiceMessage) {
            (this._socket as any).off("service_message", this._onServiceMessage);
        }
        for (const cwd of this._repoWatchers.keys()) {
            this.stopWatchingRepo(cwd);
        }
        this._cwdSubscribers.clear();
        this._sessionCwd.clear();
        this._cwdRepoRoot.clear();
        this._statusCache.clear();
        this._statusGeneration.clear();
        this._statusInFlight.clear();
        this._activeRepoMutations.clear();
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

    /**
     * Acquire a repo-level mutation lock.
     *
     * Uses the cached repo root when available (avoids an async `git rev-parse`
     * per call). If the repo root is not cached yet, resolves and caches it.
     *
     * When the repo is already locked, waits up to `waitMs` for the lock to
     * be released instead of immediately rejecting. This eliminates the
     * "Another git operation is already running" error for brief overlaps.
     */
    private async beginRepoMutation(
        cwd: string,
        type: string,
        mutationName: string,
        requestId?: string,
        sessionId?: string,
        { waitMs = 5000 }: { waitMs?: number } = {},
    ): Promise<{ key: string; token: string } | null> {
        const key = this._cwdRepoRoot.get(cwd) ?? await this.resolveRepoRoot(cwd);
        // Cache for future calls
        if (!this._cwdRepoRoot.has(cwd)) this._cwdRepoRoot.set(cwd, key);

        // Wait for existing mutation to complete (with timeout)
        const deadline = this._now() + waitMs;
        while (this._activeRepoMutations.has(key)) {
            if (this._now() >= deadline) {
                const activeMutation = this._activeRepoMutations.get(key) ?? "unknown";
                this.emit(type, {
                    ok: false,
                    reason: "busy",
                    message: `Another git operation (${activeMutation}) is still running after ${waitMs / 1000}s. Try again.`,
                }, requestId, sessionId);
                return null;
            }
            await new Promise<void>((resolve) => this._setTimeout(resolve, 50));
        }

        const token = `${mutationName}:${requestId ?? `${Date.now()}`}`;
        this._activeRepoMutations.set(key, token);
        return { key, token };
    }

    private endRepoMutation(mutation: { key: string; token: string } | null): void {
        if (!mutation) return;
        if (this._activeRepoMutations.get(mutation.key) === mutation.token) {
            this._activeRepoMutations.delete(mutation.key);
        }
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

    private registerSubscriber(cwd: string, sessionId?: string): void {
        if (!sessionId) return;

        const previousCwd = this._sessionCwd.get(sessionId);
        if (previousCwd && previousCwd !== cwd) {
            this.removeSubscriber(previousCwd, sessionId);
        }

        this._sessionCwd.set(sessionId, cwd);
        let subscribers = this._cwdSubscribers.get(cwd);
        if (!subscribers) {
            subscribers = new Set<string>();
            this._cwdSubscribers.set(cwd, subscribers);
        }
        subscribers.add(sessionId);

        if (!this._repoWatchers.has(cwd)) {
            void this.startWatchingRepo(cwd);
        }
    }

    private removeSubscriber(cwd: string, sessionId: string): void {
        const subscribers = this._cwdSubscribers.get(cwd);
        if (!subscribers) return;
        subscribers.delete(sessionId);
        if (subscribers.size > 0) return;
        this._cwdSubscribers.delete(cwd);
        this.stopWatchingRepo(cwd);
        // Evict all cache entries for this cwd so maps stay bounded across sessions.
        this.evictCwdCacheEntries(cwd);
    }

    /**
     * Evict all cwd-keyed cache state when the last subscriber for a cwd leaves.
     * Without this, _cwdRepoRoot / _statusCache / _statusGeneration grow unboundedly
     * and invalidateStatusCacheFamily() degrades to an O(N) scan over dead entries.
     */
    private evictCwdCacheEntries(cwd: string): void {
        const repoRoot = this._cwdRepoRoot.get(cwd);
        this._cwdRepoRoot.delete(cwd);
        this._statusCache.delete(cwd);
        this._statusGeneration.delete(cwd);
        this._statusInFlight.delete(cwd);

        // If the repoRoot self-mapping (repoRoot → repoRoot) is no longer referenced
        // by any remaining active cwd, evict it too.
        if (repoRoot && repoRoot !== cwd) {
            const stillReferenced = [...this._cwdRepoRoot.entries()].some(
                ([k, v]) => v === repoRoot && k !== repoRoot // exclude the repoRoot→repoRoot self-mapping
            );
            if (!stillReferenced) {
                this._cwdRepoRoot.delete(repoRoot);
                this._statusCache.delete(repoRoot);
                this._statusGeneration.delete(repoRoot);
                this._statusInFlight.delete(repoRoot);
            }
        }
    }

    /** Cleanup subscriber/watcher state when a session ends. */
    handleSessionEnded(sessionId: string): void {
        const cwd = this._sessionCwd.get(sessionId);
        if (!cwd) return;
        this._sessionCwd.delete(sessionId);
        this.removeSubscriber(cwd, sessionId);
    }

    private async startWatchingRepo(cwd: string): Promise<void> {
        if (this._repoWatchers.has(cwd)) return;

        const watchState: RepoWatchState = {
            watchers: [],
            debounceTimer: null,
            refreshInFlight: false,
            needsRefresh: false,
        };
        this._repoWatchers.set(cwd, watchState);

        try {
            const metadataPaths = await this.resolveGitMetadataWatchPaths(cwd);
            if (this._repoWatchers.get(cwd) !== watchState) return;

            for (const path of metadataPaths) {
                try {
                    const handle = this._watchFs(path, () => this.scheduleRepoRefresh(cwd));
                    if (this._repoWatchers.get(cwd) !== watchState) {
                        handle.close();
                        return;
                    }
                    watchState.watchers.push(handle);
                } catch {
                    // Best-effort watcher registration: metadata paths vary by repo layout.
                }
            }
        } catch {
            // If git metadata paths can't be resolved, keep service functional.
        }

        if (this._repoWatchers.get(cwd) === watchState && watchState.watchers.length === 0) {
            this.stopWatchingRepo(cwd);
        }
    }

    private stopWatchingRepo(cwd: string): void {
        const watchState = this._repoWatchers.get(cwd);
        if (!watchState) return;

        if (watchState.debounceTimer) {
            this._clearTimeout(watchState.debounceTimer);
            watchState.debounceTimer = null;
        }

        for (const watcher of watchState.watchers) {
            try {
                watcher.close();
            } catch {
                // Ignore close failures.
            }
        }

        this._repoWatchers.delete(cwd);
    }

    private scheduleRepoRefresh(cwd: string): void {
        const watchState = this._repoWatchers.get(cwd);
        if (!watchState) return;

        if (watchState.debounceTimer) {
            this._clearTimeout(watchState.debounceTimer);
        }

        watchState.debounceTimer = this._setTimeout(() => {
            watchState.debounceTimer = null;
            void this.pushStatusUpdateForSubscribers(cwd);
        }, METADATA_DEBOUNCE_MS);
    }

    private async pushStatusUpdateForSubscribers(cwd: string): Promise<void> {
        const watchState = this._repoWatchers.get(cwd);
        if (!watchState) return;

        if (watchState.refreshInFlight) {
            watchState.needsRefresh = true;
            return;
        }

        const subscribers = this._cwdSubscribers.get(cwd);
        if (!subscribers || subscribers.size === 0) {
            this.stopWatchingRepo(cwd);
            return;
        }

        watchState.refreshInFlight = true;
        try {
            await this.invalidateStatusCacheFamily(cwd);
            let snapshot = await this.getStatusSnapshot(cwd);
            if (snapshot.generation !== (this._statusGeneration.get(cwd) ?? 0)) {
                snapshot = await this.getStatusSnapshot(cwd);
            }
            const status = snapshot.payload;
            for (const sessionId of subscribers) {
                const sessionCwd = this._sessionCwd.get(sessionId) ?? status.cwd;
                this.emit("git_status_result", { ...status, cwd: sessionCwd }, undefined, sessionId);
            }
        } catch {
            // Ignore transient git/fs failures from proactive refresh.
        } finally {
            watchState.refreshInFlight = false;
            if (watchState.needsRefresh) {
                watchState.needsRefresh = false;
                this.scheduleRepoRefresh(cwd);
            }
        }
    }

    private async resolveGitMetadataWatchPaths(cwd: string): Promise<string[]> {
        const resolvePath = async (gitPath: string): Promise<string | null> => {
            try {
                const { stdout } = await this._execGit(["rev-parse", "--git-path", gitPath], { cwd, timeout: 5000 });
                const gitPathResult = stdout.trim();
                if (!gitPathResult) return null;
                return isAbsolute(gitPathResult) ? gitPathResult : resolve(cwd, gitPathResult);
            } catch {
                return null;
            }
        };

        const paths = new Set<string>();
        const head = await resolvePath("HEAD");
        const index = await resolvePath("index");
        const packedRefs = await resolvePath("packed-refs");
        const fetchHead = await resolvePath("FETCH_HEAD");
        const headsDir = await resolvePath("refs/heads");
        const remotesDir = await resolvePath("refs/remotes");

        let currentBranchRef: string | null = null;
        try {
            const { stdout } = await this._execGit(["symbolic-ref", "-q", "HEAD"], { cwd, timeout: 5000 });
            const ref = stdout.trim();
            if (ref.startsWith("refs/")) currentBranchRef = await resolvePath(ref);
        } catch {
            // Detached HEAD or missing ref info.
        }

        let upstreamRefPath: string | null = null;
        try {
            const { stdout } = await this._execGit(["rev-parse", "--symbolic-full-name", "@{u}"], { cwd, timeout: 5000 });
            const upstreamRef = stdout.trim();
            if (upstreamRef.startsWith("refs/")) upstreamRefPath = await resolvePath(upstreamRef);
        } catch {
            // Branch may have no upstream.
        }

        if (head) paths.add(head);
        if (index) paths.add(index);
        if (packedRefs) paths.add(packedRefs);
        if (fetchHead) paths.add(fetchHead);
        if (headsDir) paths.add(headsDir);
        if (remotesDir) paths.add(remotesDir);
        if (currentBranchRef) paths.add(currentBranchRef);
        if (upstreamRefPath) paths.add(upstreamRefPath);

        return [...paths];
    }

    // ── git status ──────────────────────────────────────────────────────

    private bumpStatusGeneration(cwd: string): number {
        const next = (this._statusGeneration.get(cwd) ?? 0) + 1;
        this._statusGeneration.set(cwd, next);
        return next;
    }

    private readonly _cwdRepoRoot = new Map<string, string>();

    private invalidateStatusCache(cwd: string): void {
        this.bumpStatusGeneration(cwd);
        this._statusCache.delete(cwd);
        this._statusInFlight.delete(cwd);
    }

    private async resolveRepoRoot(cwd: string): Promise<string> {
        try {
            const { stdout } = await this._execGit(["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
            return stdout.trim() || cwd;
        } catch {
            return cwd;
        }
    }

    private async invalidateStatusCacheFamily(cwd: string): Promise<void> {
        const repoRoot = await this.resolveRepoRoot(cwd);
        this._cwdRepoRoot.set(cwd, repoRoot);

        const seen = new Set<string>();
        const invalidateKey = (key: string) => {
            if (seen.has(key)) return;
            seen.add(key);
            this.invalidateStatusCache(key);
        };

        invalidateKey(cwd);
        invalidateKey(repoRoot);

        for (const [knownCwd, knownRoot] of this._cwdRepoRoot.entries()) {
            if (knownRoot === repoRoot) invalidateKey(knownCwd);
        }
    }

    private async getStatusSnapshot(cwd: string): Promise<GitStatusSnapshot> {
        const now = this._now();
        const generation = this._statusGeneration.get(cwd) ?? 0;

        const cached = this._statusCache.get(cwd);
        if (cached && cached.snapshot.generation === generation && cached.expiresAt > now) {
            return cached.snapshot;
        }

        const existing = this._statusInFlight.get(cwd);
        if (existing) return existing;

        const pending = this.collectStatus(cwd, generation).finally(() => {
            const current = this._statusInFlight.get(cwd);
            if (current === pending) this._statusInFlight.delete(cwd);
        });
        this._statusInFlight.set(cwd, pending);
        return pending;
    }

    private async collectStatus(cwd: string, generationAtStart: number): Promise<GitStatusSnapshot> {
        const [branchResult, toplevelResult, statusResult, diffStagedResult, abResult] = await Promise.allSettled([
            this._execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }),
            this._execGit(["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 }),
            // Use -z for NUL-delimited output — avoids C-quoting of filenames
            // with spaces/special chars and makes parsing unambiguous.
            this._execGit(["status", "--porcelain=v1", "-uall", "-z"], { cwd, timeout: 10000 }),
            this._execGit(["diff", "--cached", "--stat"], { cwd, timeout: 10000 }),
            this._execGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd, timeout: 5000 }),
        ]);

        const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
        const repoRoot = toplevelResult.status === "fulfilled" ? toplevelResult.value.stdout.trim() : cwd;
        this._cwdRepoRoot.set(cwd, repoRoot || cwd);
        if (repoRoot) this._cwdRepoRoot.set(repoRoot, repoRoot);
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

        const payload: GitStatusResultPayload = {
            ok: true,
            cwd,
            branch,
            repoRoot,
            changes,
            ahead,
            behind,
            hasUpstream,
            diffStaged,
        };

        const snapshot: GitStatusSnapshot = {
            generation: generationAtStart,
            payload,
        };

        if ((this._statusGeneration.get(cwd) ?? 0) === generationAtStart) {
            this._statusCache.set(cwd, {
                snapshot,
                expiresAt: this._now() + STATUS_CACHE_TTL_MS,
            });
        }

        return snapshot;
    }

    private async handleStatus(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_status_result", requestId, sessionId);
        if (!cwd) return;
        this.registerSubscriber(cwd, sessionId);

        try {
            let snapshot = await this.getStatusSnapshot(cwd);
            if (snapshot.generation !== (this._statusGeneration.get(cwd) ?? 0)) {
                snapshot = await this.getStatusSnapshot(cwd);
            }
            this.emit("git_status_result", snapshot.payload, requestId, sessionId);
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
            const repoRoot = this._cwdRepoRoot.get(cwd) ?? (await this.resolveRepoRoot(cwd));
            if (!this._cwdRepoRoot.has(cwd)) this._cwdRepoRoot.set(cwd, repoRoot);

            const args = staged
                ? ["diff", "--cached", "--", filePath]
                : ["diff", "--", filePath];
            const { stdout: diff } = await this._execGit(args, { cwd: repoRoot, timeout: 10000 });
            this.emit("git_diff_result", { ok: true, diff }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_diff_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── git branches / full status ───────────────────────────────────────

    private async collectBranches(cwd: string): Promise<GitBranchResultPayload> {
        const { stdout: currentBranch } = await this._execGit(["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd, timeout: 5000 },
        );

        // Use for-each-ref for reliable branch listing with ref-type awareness.
        // List local branches from refs/heads and remote branches from refs/remotes,
        // excluding remote HEAD aliases (e.g. refs/remotes/origin/HEAD).
        const [localResult, remoteResult] = await Promise.allSettled([
            this._execGit(["for-each-ref", "--sort=-committerdate",
                    "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)\t%(HEAD)",
                    "refs/heads"],
                { cwd, timeout: 10000 },
            ),
            this._execGit(["for-each-ref", "--sort=-committerdate",
                    "--format=%(refname:short)\t%(objectname:short)\t%(committerdate:relative)",
                    "refs/remotes", "--exclude=refs/remotes/*/HEAD"],
                { cwd, timeout: 10000 },
            ),
        ]);

        const branches: GitBranchResultPayload["branches"] = [];

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

        return {
            currentBranch: currentBranch.trim(),
            branches,
        };
    }

    private async handleBranches(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_branches_result", requestId, sessionId);
        if (!cwd) return;
        this.registerSubscriber(cwd, sessionId);

        try {
            const branchData = await this.collectBranches(cwd);
            this.emit("git_branches_result", {
                ok: true,
                ...branchData,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_branches_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    private async handleFullStatus(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_full_status_result", requestId, sessionId);
        if (!cwd) return;
        this.registerSubscriber(cwd, sessionId);

        try {
            const [statusResult, branchResult, worktreeResult] = await Promise.allSettled([
                this.getStatusSnapshot(cwd),
                this.collectBranches(cwd),
                this.collectWorktrees(cwd),
            ]);

            if (statusResult.status !== "fulfilled") {
                throw statusResult.reason;
            }

            let statusSnapshot = statusResult.value;
            let branchData = branchResult.status === "fulfilled"
                ? branchResult.value
                : null;
            let worktreeData = worktreeResult.status === "fulfilled"
                ? worktreeResult.value
                : null;

            if (statusSnapshot.generation !== (this._statusGeneration.get(cwd) ?? 0)) {
                // Full-status collection crossed an invalidation boundary.
                // Re-read all components so we don't mix fresh status with stale metadata.
                const [freshStatus, freshBranches, freshWorktrees] = await Promise.allSettled([
                    this.getStatusSnapshot(cwd),
                    this.collectBranches(cwd),
                    this.collectWorktrees(cwd),
                ]);

                if (freshStatus.status !== "fulfilled") {
                    throw freshStatus.reason;
                }
                statusSnapshot = freshStatus.value;
                branchData = freshBranches.status === "fulfilled" ? freshBranches.value : null;
                worktreeData = freshWorktrees.status === "fulfilled" ? freshWorktrees.value : null;
            }

            const status = statusSnapshot.payload;
            const safeBranchData = branchData ?? { currentBranch: status.branch, branches: [] };
            const safeWorktreeData = worktreeData ?? { worktrees: [] };

            this.emit("git_full_status_result", {
                ok: true,
                status,
                ...safeBranchData,
                ...safeWorktreeData,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_full_status_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
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
        const mutation = await this.beginRepoMutation(cwd, "git_checkout_result", "checkout", requestId, sessionId);
        if (!mutation) return;

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
                    await this._execGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], { cwd, timeout: 5000 });
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

            await this._execGit(args, { cwd, timeout: 15000 });
            await this.invalidateStatusCacheFamily(cwd);

            this.emit("git_checkout_result", {
                ok: true,
                branch: targetBranch,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_checkout_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
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
            const repoRoot = this._cwdRepoRoot.get(cwd) ?? (await this.resolveRepoRoot(cwd));
            if (!this._cwdRepoRoot.has(cwd)) this._cwdRepoRoot.set(cwd, repoRoot);

            const args = all ? ["add", "--all"] : ["add", "--", ...paths];
            await this._execGit(args, { cwd: repoRoot, timeout: 15000 });
            await this.invalidateStatusCacheFamily(cwd);
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
            const repoRoot = this._cwdRepoRoot.get(cwd) ?? (await this.resolveRepoRoot(cwd));
            if (!this._cwdRepoRoot.has(cwd)) this._cwdRepoRoot.set(cwd, repoRoot);

            const args = all
                ? ["restore", "--staged", ":/"]
                : ["restore", "--staged", "--", ...paths];
            await this._execGit(args, { cwd: repoRoot, timeout: 15000 });
            await this.invalidateStatusCacheFamily(cwd);
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

        const mutation = await this.beginRepoMutation(cwd, "git_commit_result", "commit", requestId, sessionId);
        if (!mutation) return;

        try {
            const { stdout } = await this._execGit(["commit", "-m", message],
                { cwd, timeout: 30000 },
            );

            // Parse the short summary (e.g. "[main abc1234] Fix thing\n 1 file changed...")
            const firstLine = stdout.split("\n")[0] ?? "";
            await this.invalidateStatusCacheFamily(cwd);

            this.emit("git_commit_result", {
                ok: true,
                summary: firstLine.trim(),
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_commit_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    // ── git worktrees ─────────────────────────────────────────────────

    private async collectWorktrees(cwd: string): Promise<GitWorktreeResultPayload> {
        // Get repo root so we can show relative paths
        const repoRoot = this._cwdRepoRoot.get(cwd) ?? (await this.resolveRepoRoot(cwd));
        if (!this._cwdRepoRoot.has(cwd)) this._cwdRepoRoot.set(cwd, repoRoot);

        // Parse porcelain output — each worktree block is separated by a blank line
        const { stdout: listOutput } = await this._execGit(["worktree", "list", "--porcelain"],
            { cwd, timeout: 10000 },
        );

        interface WorktreeEntry {
            path: string;
            head: string;
            branch: string;
            isBare: boolean;
            isDetached: boolean;
        }

        const worktrees: WorktreeEntry[] = [];
        let current: Partial<WorktreeEntry> = {};

        for (const line of listOutput.split("\n")) {
            if (line === "") {
                if (current.path) {
                    worktrees.push({
                        path: current.path,
                        head: current.head ?? "",
                        branch: current.branch ?? "",
                        isBare: current.isBare ?? false,
                        isDetached: current.isDetached ?? false,
                    });
                }
                current = {};
                continue;
            }
            if (line.startsWith("worktree ")) current.path = line.substring(9);
            else if (line.startsWith("HEAD ")) current.head = line.substring(5);
            else if (line.startsWith("branch ")) {
                // Strip refs/heads/ prefix for display
                const ref = line.substring(7);
                current.branch = ref.startsWith("refs/heads/") ? ref.substring(11) : ref;
            } else if (line === "bare") current.isBare = true;
            else if (line === "detached") current.isDetached = true;
        }
        // Handle last entry if no trailing newline
        if (current.path) {
            worktrees.push({
                path: current.path,
                head: current.head ?? "",
                branch: current.branch ?? "",
                isBare: current.isBare ?? false,
                isDetached: current.isDetached ?? false,
            });
        }

        // For each worktree, get change count in parallel
        const enriched = await Promise.all(
            worktrees.filter((w) => !w.isBare).map(async (wt) => {
                let changeCount = 0;
                let ahead = 0;
                let behind = 0;
                try {
                    const { stdout } = await this._execGit(["status", "--porcelain=v1", "-uall"],
                        { cwd: wt.path, timeout: 5000 },
                    );
                    changeCount = stdout.split("\n").filter((l) => l.length > 0).length;
                } catch { /* ignore — worktree might be mid-operation */ }

                try {
                    const { stdout } = await this._execGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"],
                        { cwd: wt.path, timeout: 5000 },
                    );
                    const [a, b] = stdout.trim().split(/\s+/);
                    ahead = parseInt(a, 10) || 0;
                    behind = parseInt(b, 10) || 0;
                } catch { /* no upstream */ }

                // Build a relative display path from the repo root
                let displayPath = wt.path;
                if (wt.path.startsWith(repoRoot)) {
                    const rel = wt.path.substring(repoRoot.length);
                    displayPath = rel.startsWith("/") ? rel.substring(1) : rel;
                    if (!displayPath) displayPath = "."; // main worktree
                }

                return {
                    path: wt.path,
                    displayPath,
                    branch: wt.branch,
                    shortHash: wt.head.substring(0, 7),
                    isDetached: wt.isDetached,
                    isMain: wt.path === repoRoot,
                    changeCount,
                    ahead,
                    behind,
                };
            }),
        );

        return { worktrees: enriched };
    }

    private async handleWorktrees(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_worktrees_result", requestId, sessionId);
        if (!cwd) return;
        this.registerSubscriber(cwd, sessionId);

        try {
            const worktreeData = await this.collectWorktrees(cwd);
            this.emit("git_worktrees_result", {
                ok: true,
                ...worktreeData,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_worktrees_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        }
    }

    // ── upstream resolution / sync helpers ──────────────────────────────

    private async readGitConfigValues(cwd: string, key: string): Promise<string[]> {
        try {
            const { stdout } = await this._execGit(["config", "--get-all", key], { cwd, timeout: 5000 });
            return stdout
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private async resolveUpstream(cwd: string): Promise<GitUpstreamResolution> {
        let localBranch = "";
        try {
            const { stdout } = await this._execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
            localBranch = stdout.trim();
        } catch (err) {
            return {
                ok: false,
                reason: "detachedHead",
                message: err instanceof Error ? err.message : String(err),
            };
        }

        if (!localBranch || localBranch === "HEAD") {
            return {
                ok: false,
                reason: "detachedHead",
                message: "Cannot sync a detached HEAD. Check out a branch first.",
            };
        }

        const [remotes, mergeRefs] = await Promise.all([
            this.readGitConfigValues(cwd, `branch.${localBranch}.remote`),
            this.readGitConfigValues(cwd, `branch.${localBranch}.merge`),
        ]);

        if (remotes.length > 1 || mergeRefs.length > 1) {
            return {
                ok: false,
                reason: "ambiguousUpstream",
                message: `Branch ${localBranch} has multiple upstream targets configured. Repair its upstream before pulling.`,
                localBranch,
                remote: remotes[0],
                mergeBranches: mergeRefs,
            };
        }

        const remote = remotes[0] ?? "";
        const mergeRef = mergeRefs[0] ?? "";
        const mergeBranch = mergeRef.startsWith("refs/heads/") ? mergeRef.slice(11) : mergeRef;

        if (!remote || !mergeBranch) {
            return {
                ok: false,
                reason: "missingUpstream",
                message: `Branch ${localBranch} does not have exactly one upstream configured. Set its tracking branch first.`,
                localBranch,
                remote: remote || undefined,
            };
        }

        return {
            ok: true,
            localBranch,
            remote,
            mergeBranch,
            trackingRef: `${remote}/${mergeBranch}`,
        };
    }

    private classifySyncFailure(message: string): { reason?: "conflict" | "nonFastForward"; message: string } {
        if (
            message.includes("CONFLICT")
            || message.includes("Resolve all conflicts manually")
            || message.includes("could not apply")
            || message.includes("unmerged")
            || message.includes("unresolved conflict")
        ) {
            return {
                reason: "conflict",
                message: "Sync stopped because of conflicts. Resolve them in git, then try again.",
            };
        }
        if (message.includes("Not possible to fast-forward")) {
            return {
                reason: "nonFastForward",
                message: "Cannot fast-forward. Rebase or merge explicitly to integrate remote changes.",
            };
        }
        return { message };
    }

    // ── git pull ────────────────────────────────────────────────────────

    private async handlePull(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_pull_result", requestId, sessionId);
        if (!cwd) return;
        const rebase = payload.rebase !== false;
        const mutation = await this.beginRepoMutation(cwd, "git_pull_result", "pull", requestId, sessionId);
        if (!mutation) return;

        try {
            const upstream = await this.resolveUpstream(cwd);
            if (!upstream.ok) {
                this.emit("git_pull_result", {
                    ok: false,
                    reason: upstream.reason,
                    message: upstream.message,
                    branch: upstream.localBranch,
                    remote: upstream.remote,
                    mergeBranches: upstream.mergeBranches,
                }, requestId, sessionId);
                return;
            }

            const fetchResult = await this._execGit(
                ["fetch", upstream.remote, upstream.mergeBranch],
                { cwd, timeout: 60000 },
            );

            const integrateArgs = rebase
                ? ["rebase", upstream.trackingRef]
                : ["merge", "--ff-only", upstream.trackingRef];
            const integrateResult = await this._execGit(integrateArgs, { cwd, timeout: 60000 });

            const output = [
                fetchResult.stdout,
                fetchResult.stderr,
                integrateResult.stdout,
                integrateResult.stderr,
            ].join("\n").trim();

            await this.invalidateStatusCacheFamily(cwd);

            this.emit("git_pull_result", {
                ok: true,
                output,
                branch: upstream.localBranch,
                remote: upstream.remote,
                upstream: upstream.trackingRef,
            }, requestId, sessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const classified = this.classifySyncFailure(message);
            if (classified.reason === "conflict") {
                await this.invalidateStatusCacheFamily(cwd);
            }
            this.emit("git_pull_result", {
                ok: false,
                reason: classified.reason,
                message: classified.message,
                output: message,
            }, requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    private async handleSetUpstream(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_set_upstream_result", requestId, sessionId);
        if (!cwd) return;

        const remote = typeof payload.remote === "string" ? payload.remote.trim() : "";
        const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
        if (!isValidRemoteName(remote)) {
            this.emitError("git_set_upstream_result", "Invalid remote name", requestId, sessionId);
            return;
        }
        if (!isValidBranchName(branch)) {
            this.emitError("git_set_upstream_result", "Invalid branch name", requestId, sessionId);
            return;
        }

        const mutation = await this.beginRepoMutation(cwd, "git_set_upstream_result", "set-upstream", requestId, sessionId);
        if (!mutation) return;

        try {
            const { stdout } = await this._execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
            const localBranch = stdout.trim();
            if (!localBranch || localBranch === "HEAD") {
                this.emit("git_set_upstream_result", {
                    ok: false,
                    reason: "detachedHead",
                    message: "Cannot set upstream while HEAD is detached.",
                }, requestId, sessionId);
                return;
            }

            await this._execGit(["branch", `--set-upstream-to=${remote}/${branch}`, localBranch], { cwd, timeout: 15000 });
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_set_upstream_result", {
                ok: true,
                summary: `Branch ${localBranch} now tracks ${remote}/${branch}`,
                branch: localBranch,
                upstream: `${remote}/${branch}`,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_set_upstream_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    // ── git merge ───────────────────────────────────────────────────────

    private async handleMerge(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_merge_result", requestId, sessionId);
        if (!cwd) return;

        const branch = typeof payload.branch === "string" ? payload.branch : "";
        if (!branch || !isValidBranchName(branch)) {
            this.emitError("git_merge_result", "Invalid branch name", requestId, sessionId);
            return;
        }

        const mutation = await this.beginRepoMutation(cwd, "git_merge_result", "merge", requestId, sessionId);
        if (!mutation) return;

        try {
            // Prevent merging current branch into itself
            const { stdout: currentBranchOut } = await this._execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
            const currentBranch = currentBranchOut.trim();
            if (currentBranch && currentBranch === branch) {
                this.emit("git_merge_result", { ok: false, message: "Cannot merge branch into itself." }, requestId, sessionId);
                return;
            }

            // Use "--" end-of-options separator so `branch` is always treated as
            // a ref, never as a git option (guards against e.g. "--abort" injection).
            const result = await this._execGit(["merge", "--", branch], { cwd, timeout: 60000 });
            const output = (result.stdout + "\n" + result.stderr).trim();
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_merge_result", { ok: true, output }, requestId, sessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const classified = this.classifySyncFailure(message);
            if (classified.reason === "conflict") {
                await this.invalidateStatusCacheFamily(cwd);
            }
            this.emit("git_merge_result", {
                ok: false,
                reason: classified.reason,
                message: classified.message,
                output: message,
            }, requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    // ── git merge --abort ──────────────────────────────────────────────

    private async handleMergeAbort(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_merge_abort_result", requestId, sessionId);
        if (!cwd) return;

        const mutation = await this.beginRepoMutation(cwd, "git_merge_abort_result", "merge-abort", requestId, sessionId);
        if (!mutation) return;

        try {
            await this._execGit(["merge", "--abort"], { cwd, timeout: 30000 });
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_merge_abort_result", { ok: true }, requestId, sessionId);
        } catch (err) {
            this.emit("git_merge_abort_result", {
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            }, requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
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
        const mutation = await this.beginRepoMutation(cwd, "git_push_result", "push", requestId, sessionId);
        if (!mutation) return;

        try {
            // Determine current branch for --set-upstream
            const { stdout: branchName } = await this._execGit(["rev-parse", "--abbrev-ref", "HEAD"],
                { cwd, timeout: 5000 },
            );
            const branch = branchName.trim();

            let args: string[];
            if (setUpstream) {
                // Resolve the default remote dynamically instead of hardcoding "origin".
                // Try the configured push remote, then fall back to the first remote.
                let remote = "origin";
                try {
                    const { stdout } = await this._execGit(["config", "--get", `branch.${branch}.remote`],
                        { cwd, timeout: 5000 },
                    );
                    if (stdout.trim()) remote = stdout.trim();
                } catch {
                    // No tracked remote — try first remote in list
                    try {
                        const { stdout } = await this._execGit(["remote"],
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
            const result = await this._execGit(args, { cwd, timeout: 60000 });
            const output = (result.stdout + "\n" + result.stderr).trim();
            await this.invalidateStatusCacheFamily(cwd);

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
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    // ── git rebase ────────────────────────────────────────────────────────

    private async handleRebase(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_rebase_result", requestId, sessionId);
        if (!cwd) return;

        const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
        if (!branch || !isValidBranchName(branch)) {
            this.emitError("git_rebase_result", "Invalid branch name for rebase", requestId, sessionId);
            return;
        }

        const mutation = await this.beginRepoMutation(cwd, "git_rebase_result", "rebase", requestId, sessionId);
        if (!mutation) return;

        try {
            const result = await this._execGit(["rebase", "--", branch], { cwd, timeout: 60000 });
            const output = (result.stdout + "\n" + result.stderr).trim();
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_rebase_result", { ok: true, output }, requestId, sessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const classified = this.classifySyncFailure(message);
            if (classified.reason === "conflict") {
                await this.invalidateStatusCacheFamily(cwd);
            }
            this.emit("git_rebase_result", {
                ok: false,
                reason: classified.reason,
                message: classified.message,
                output: message,
            }, requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    private async handleRebaseAbort(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_rebase_abort_result", requestId, sessionId);
        if (!cwd) return;

        const mutation = await this.beginRepoMutation(cwd, "git_rebase_abort_result", "rebase-abort", requestId, sessionId);
        if (!mutation) return;

        try {
            const result = await this._execGit(["rebase", "--abort"], { cwd, timeout: 30000 });
            const output = (result.stdout + "\n" + result.stderr).trim();
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_rebase_abort_result", { ok: true, output }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_rebase_abort_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    private async handleRebaseContinue(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_rebase_continue_result", requestId, sessionId);
        if (!cwd) return;

        const mutation = await this.beginRepoMutation(cwd, "git_rebase_continue_result", "rebase-continue", requestId, sessionId);
        if (!mutation) return;

        try {
            // Use GIT_EDITOR=true so the headless runner doesn't fail when git
            // tries to open an editor for the rebase todo/commit message.
            const result = await this._execGit(
                ["rebase", "--continue"],
                { cwd, timeout: 60000, env: { ...process.env, GIT_EDITOR: "true" } },
            );
            const output = (result.stdout + "\n" + result.stderr).trim();
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_rebase_continue_result", { ok: true, output }, requestId, sessionId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const classified = this.classifySyncFailure(message);
            if (classified.reason === "conflict") {
                await this.invalidateStatusCacheFamily(cwd);
            }
            this.emit("git_rebase_continue_result", {
                ok: false,
                reason: classified.reason,
                message: classified.message,
                output: message,
            }, requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    // ── git worktree add/remove ───────────────────────────────────────────

    private async handleWorktreeAdd(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_worktree_add_result", requestId, sessionId);
        if (!cwd) return;

        const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
        const path = typeof payload.path === "string" ? payload.path.trim() : "";

        if (!branch || !isValidBranchName(branch)) {
            this.emitError("git_worktree_add_result", "Invalid branch name", requestId, sessionId);
            return;
        }
        if (!path) {
            this.emitError("git_worktree_add_result", "Missing worktree path", requestId, sessionId);
            return;
        }

        // Validate the resolved worktree path is within allowed roots
        const resolvedPath = path.startsWith("/") ? path : join(cwd, path);
        if (!isCwdAllowed(resolvedPath)) {
            this.emitError("git_worktree_add_result", "Worktree path outside allowed roots", requestId, sessionId);
            return;
        }

        const mutation = await this.beginRepoMutation(cwd, "git_worktree_add_result", "worktree-add", requestId, sessionId);
        if (!mutation) return;

        try {
            // Use -b to create a new branch at the worktree. If the branch already
            // exists locally, just check it out in the new worktree.
            const branchExists = await this._execGit(
                ["rev-parse", "--verify", `refs/heads/${branch}`],
                { cwd, timeout: 5000 },
            ).then(
                (r) => r.stdout.trim(),
                () => "",
            );

            const args = branchExists
                ? ["worktree", "add", "--", path, branch]
                : ["worktree", "add", "-b", branch, "--", path];
            await this._execGit(args, { cwd, timeout: 30000 });
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_worktree_add_result", {
                ok: true,
                branch,
                path,
            }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_worktree_add_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }

    private async handleWorktreeRemove(
        payload: Record<string, unknown>,
        requestId?: string,
        sessionId?: string,
    ): Promise<void> {
        const cwd = this.validateCwd(payload.cwd, "git_worktree_remove_result", requestId, sessionId);
        if (!cwd) return;

        const worktreePath = typeof payload.path === "string" ? payload.path.trim() : "";
        const force = payload.force === true;

        if (!worktreePath) {
            this.emitError("git_worktree_remove_result", "Missing worktree path", requestId, sessionId);
            return;
        }

        // Validate the resolved worktree path is within allowed roots
        const resolvedPath = worktreePath.startsWith("/") ? worktreePath : join(cwd, worktreePath);
        if (!isCwdAllowed(resolvedPath)) {
            this.emitError("git_worktree_remove_result", "Worktree path outside allowed roots", requestId, sessionId);
            return;
        }

        // Validate that the path is a known worktree to prevent arbitrary deletion
        try {
            const { stdout: listOutput } = await this._execGit(
                ["worktree", "list", "--porcelain"],
                { cwd, timeout: 10000 },
            );
            const knownPaths = listOutput.split("\n")
                .filter((line) => line.startsWith("worktree "))
                .map((line) => line.substring(9));
            if (!knownPaths.includes(worktreePath)) {
                this.emitError("git_worktree_remove_result", "Path is not a known git worktree", requestId, sessionId);
                return;
            }
        } catch (err) {
            this.emitError("git_worktree_remove_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
            return;
        }

        const mutation = await this.beginRepoMutation(cwd, "git_worktree_remove_result", "worktree-remove", requestId, sessionId);
        if (!mutation) return;

        try {
            const args = force
                ? ["worktree", "remove", "--force", "--", worktreePath]
                : ["worktree", "remove", "--", worktreePath];
            await this._execGit(args, { cwd, timeout: 30000 });
            await this.invalidateStatusCacheFamily(cwd);
            this.emit("git_worktree_remove_result", { ok: true, path: worktreePath }, requestId, sessionId);
        } catch (err) {
            this.emitError("git_worktree_remove_result", err instanceof Error ? err.message : String(err), requestId, sessionId);
        } finally {
            this.endRepoMutation(mutation);
        }
    }
}
