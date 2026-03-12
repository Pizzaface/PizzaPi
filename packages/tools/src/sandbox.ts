/**
 * Sandbox Manager Wrapper Module
 *
 * Thin wrapper around @anthropic-ai/sandbox-runtime's SandboxManager that
 * provides a clean API for all PizzaPi integration points. This is the
 * central sandbox module — all other tasks import from here.
 *
 * @module
 */

import {
    SandboxManager,
    SandboxViolationStore,
    type SandboxRuntimeConfig,
    type SandboxViolationEvent,
    getDefaultWritePaths,
} from "@anthropic-ai/sandbox-runtime";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Resolved sandbox config from the CLI config module.
 * Re-declared here to avoid a cross-package dependency on @pizzapi/cli.
 * The worker session passes this in at init time.
 */
export interface ResolvedSandboxConfig {
    enabled: boolean;
    mode: "enforce" | "audit" | "off";
    network: {
        mode: "denylist" | "allowlist";
        allowedDomains: string[];
        deniedDomains: string[];
    };
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
    };
    sockets: {
        deny: string[];
    };
    mcp: {
        allowedDomains: string[];
        allowWrite: string[];
    };
}

/** 3-tier sandbox profiles for different tool types. */
export type SandboxTier = "bash" | "filesystem" | "mcp";

/** Result of a path validation check. */
export interface ValidationResult {
    allowed: boolean;
    reason?: string;
}

/** A record of a sandbox violation (for audit mode). */
export interface ViolationRecord {
    timestamp: Date;
    tier: SandboxTier;
    operation: string;
    target: string;
    reason: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of violations to keep in the ring buffer. */
const MAX_VIOLATIONS = 100;

// ── Module-level state (singleton) ────────────────────────────────────────────

let _config: ResolvedSandboxConfig | null = null;
let _initialized = false;
let _initFailed = false;
let _violations: ViolationRecord[] = [];
let _violationListeners: Array<(violation: ViolationRecord) => void> = [];
let _sshAuthSock: string | null = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the sandbox. Call once per worker session.
 *
 * Translates `ResolvedSandboxConfig` into the `SandboxRuntimeConfig` expected
 * by the upstream `SandboxManager` and calls `SandboxManager.initialize()`.
 *
 * Graceful degradation:
 * - On unsupported platforms (Windows), logs a warning and returns.
 * - If `SandboxManager.initialize()` throws, logs the error and continues
 *   unsandboxed. Never crashes the worker.
 */
export async function initSandbox(config: ResolvedSandboxConfig): Promise<void> {
    _config = config;
    _violations = [];
    _initFailed = false;

    // If sandbox is disabled or mode is "off", skip initialization
    if (!config.enabled || config.mode === "off") {
        _initialized = true;
        return;
    }

    // Detect SSH agent socket for allowlisting
    _sshAuthSock = process.env.SSH_AUTH_SOCK ?? null;
    if (_sshAuthSock) {
        console.log(`[sandbox] SSH agent detected: ${_sshAuthSock}`);
    }

    // Check platform support
    if (!SandboxManager.isSupportedPlatform()) {
        console.warn(
            "[sandbox] Platform not supported for sandboxing. Running unsandboxed.",
        );
        _initialized = true;
        _initFailed = true;
        return;
    }

    // Build the SandboxRuntimeConfig from our ResolvedSandboxConfig
    const runtimeConfig = buildRuntimeConfig(config, "bash");

    try {
        await SandboxManager.initialize(runtimeConfig);
        _initialized = true;
        console.log(`[sandbox] Initialized in "${config.mode}" mode`);
    } catch (err) {
        console.error(
            "[sandbox] Failed to initialize sandbox. Continuing unsandboxed:",
            err instanceof Error ? err.message : String(err),
        );
        _initialized = true;
        _initFailed = true;
    }
}

/**
 * Wrap a shell command with sandbox restrictions (bash tier).
 *
 * In enforce mode, returns the command wrapped with OS-level sandboxing.
 * In audit mode, returns the original command but logs what would be blocked.
 * When sandbox is off/failed, returns the original command unchanged.
 */
export async function wrapCommand(cmd: string): Promise<string> {
    if (!_isEnforceable()) {
        if (_config?.mode === "audit") {
            _recordViolation("bash", "execute", cmd, "Audit: command would be sandboxed");
        }
        return cmd;
    }

    try {
        return await SandboxManager.wrapWithSandbox(cmd);
    } catch (err) {
        console.error(
            "[sandbox] Failed to wrap command, running unsandboxed:",
            err instanceof Error ? err.message : String(err),
        );
        return cmd;
    }
}

/**
 * Validate a path for read or write operations (filesystem tier).
 *
 * Uses the configured deny/allow lists to check whether the path is permitted.
 * In audit mode, returns `{ allowed: false, reason }` but the caller should
 * NOT block the operation — only log it.
 */
export function validatePath(
    filePath: string,
    op: "read" | "write",
): ValidationResult {
    if (!_config) {
        return { allowed: true };
    }

    if (!_config.enabled || _config.mode === "off") {
        return { allowed: true };
    }

    const normalizedPath = _normalizePath(filePath);

    if (op === "read") {
        return _validateReadPath(normalizedPath);
    } else {
        return _validateWritePath(normalizedPath);
    }
}

/**
 * Get environment variables for sandboxed child processes.
 *
 * Returns proxy env vars if the sandbox network proxy is active,
 * otherwise returns an empty object.
 */
export function getSandboxEnv(): Record<string, string> {
    if (!_isEnforceable()) {
        return {};
    }

    const env: Record<string, string> = {};

    const proxyPort = SandboxManager.getProxyPort();
    const socksPort = SandboxManager.getSocksProxyPort();

    if (proxyPort) {
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
    }

    if (socksPort) {
        const socksUrl = `socks5://127.0.0.1:${socksPort}`;
        env.ALL_PROXY = socksUrl;
        env.all_proxy = socksUrl;
    }

    return env;
}

/**
 * Check if the sandbox is active and enforcing restrictions.
 *
 * Returns `true` if:
 * - `initSandbox()` has been called successfully
 * - Config is enabled and mode is not "off"
 * - The platform is supported and init didn't fail
 */
export function isSandboxActive(): boolean {
    if (!_initialized || !_config) return false;
    if (!_config.enabled || _config.mode === "off") return false;
    if (_initFailed) return false;
    return true;
}

/**
 * Get the current sandbox mode.
 *
 * Returns the configured mode, or "off" if sandbox was never initialized.
 */
export function getSandboxMode(): "enforce" | "audit" | "off" {
    return _config?.mode ?? "off";
}

/**
 * Get all recorded violations (audit mode).
 *
 * Returns a copy of the ring buffer (capped at MAX_VIOLATIONS entries).
 */
export function getViolations(): ViolationRecord[] {
    return [..._violations];
}

/**
 * Clear the violation ring buffer.
 */
export function clearViolations(): void {
    _violations = [];
}

/**
 * Subscribe to violation events. Returns an unsubscribe function.
 * Each listener is called synchronously when a new violation is recorded.
 */
export function onViolation(listener: (violation: ViolationRecord) => void): () => void {
    _violationListeners.push(listener);
    return () => {
        _violationListeners = _violationListeners.filter((l) => l !== listener);
    };
}

/**
 * Get the current resolved sandbox config.
 * Returns null if sandbox has not been initialized.
 */
export function getResolvedConfig(): ResolvedSandboxConfig | null {
    return _config ? { ..._config } : null;
}

/**
 * Cleanup sandbox resources.
 *
 * Resets the `SandboxManager` and clears module state.
 * Safe to call even if sandbox was never initialized.
 */
export async function cleanupSandbox(): Promise<void> {
    if (_initialized && !_initFailed && _config?.enabled && _config.mode !== "off") {
        try {
            await SandboxManager.reset();
        } catch (err) {
            console.error(
                "[sandbox] Error during cleanup:",
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    _config = null;
    _initialized = false;
    _initFailed = false;
    _violations = [];
    _violationListeners = [];
    _sshAuthSock = null;
}

// ── Profile builders (3-tier system) ──────────────────────────────────────────

/**
 * Build a `SandboxRuntimeConfig` for a specific tier from a `ResolvedSandboxConfig`.
 *
 * Tiers:
 * - `bash`: Full sandbox — filesystem + network restrictions
 * - `filesystem`: Path validation only — for read_file, write_file, search
 * - `mcp`: Maximum restriction — no network, /tmp-only writes, no sockets
 */
export function buildRuntimeConfig(
    config: ResolvedSandboxConfig,
    tier: SandboxTier,
): SandboxRuntimeConfig {
    switch (tier) {
        case "bash":
            return _buildBashConfig(config);
        case "filesystem":
            return _buildFilesystemConfig(config);
        case "mcp":
            return _buildMcpConfig(config);
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _buildBashConfig(config: ResolvedSandboxConfig): SandboxRuntimeConfig {
    const allowUnixSockets = _buildSocketAllowlist(config);

    return {
        network: {
            allowedDomains: config.network.mode === "allowlist"
                ? config.network.allowedDomains
                : [],
            deniedDomains: config.network.mode === "denylist"
                ? config.network.deniedDomains
                : [],
            allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
            allowLocalBinding: true,
        },
        filesystem: {
            denyRead: config.filesystem.denyRead,
            allowWrite: [
                ...getDefaultWritePaths(),
                ...config.filesystem.allowWrite,
            ],
            denyWrite: config.filesystem.denyWrite,
        },
    };
}

function _buildFilesystemConfig(config: ResolvedSandboxConfig): SandboxRuntimeConfig {
    return {
        network: {
            // Filesystem tier doesn't restrict network
            allowedDomains: [],
            deniedDomains: [],
        },
        filesystem: {
            denyRead: config.filesystem.denyRead,
            allowWrite: [
                ...getDefaultWritePaths(),
                ...config.filesystem.allowWrite,
            ],
            denyWrite: config.filesystem.denyWrite,
        },
    };
}

function _buildMcpConfig(config: ResolvedSandboxConfig): SandboxRuntimeConfig {
    return {
        network: {
            // MCP tier: only allow explicitly configured domains
            allowedDomains: config.mcp.allowedDomains,
            deniedDomains: [],
        },
        filesystem: {
            denyRead: config.filesystem.denyRead,
            allowWrite: config.mcp.allowWrite,
            denyWrite: config.filesystem.denyWrite,
        },
    };
}

/**
 * Build the Unix socket allowlist.
 * Includes SSH_AUTH_SOCK if detected, minus any denied sockets.
 */
function _buildSocketAllowlist(config: ResolvedSandboxConfig): string[] {
    const sockets: string[] = [];

    // Auto-detect SSH agent socket
    if (_sshAuthSock) {
        sockets.push(_sshAuthSock);
    }

    // Filter out denied sockets
    const denySet = new Set(config.sockets.deny);
    return sockets.filter((s) => !denySet.has(s));
}

/** Check if the sandbox is in a state where it can enforce restrictions. */
function _isEnforceable(): boolean {
    return _initialized && !_initFailed && _config?.enabled === true && _config.mode === "enforce";
}

/** Normalize a file path for comparison against config paths. */
function _normalizePath(filePath: string): string {
    // Resolve relative paths, expand ~
    if (filePath.startsWith("~")) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
        return home + filePath.slice(1);
    }
    // If not absolute, treat as relative to cwd
    if (!filePath.startsWith("/")) {
        return process.cwd() + "/" + filePath;
    }
    return filePath;
}

/** Check if a path is denied for reading. */
function _validateReadPath(normalizedPath: string): ValidationResult {
    if (!_config) return { allowed: true };

    for (const denied of _config.filesystem.denyRead) {
        if (_pathMatchesDeny(normalizedPath, denied)) {
            const reason = `Read denied: path "${normalizedPath}" matches deny rule "${denied}"`;

            // Always record the violation (for both enforce and audit)
            _recordViolation("filesystem", "read", normalizedPath, reason);

            if (_config.mode === "audit") {
                return { allowed: true, reason };
            }

            return { allowed: false, reason };
        }
    }

    return { allowed: true };
}

/** Check if a path is permitted for writing. */
function _validateWritePath(normalizedPath: string): ValidationResult {
    if (!_config) return { allowed: true };

    // Check denyWrite first (takes precedence)
    for (const denied of _config.filesystem.denyWrite) {
        if (_pathMatchesDeny(normalizedPath, denied)) {
            const reason = `Write denied: path "${normalizedPath}" matches deny rule "${denied}"`;

            _recordViolation("filesystem", "write", normalizedPath, reason);

            if (_config.mode === "audit") {
                return { allowed: true, reason };
            }

            return { allowed: false, reason };
        }
    }

    // Check if path is within any allowWrite path
    const isAllowed = _config.filesystem.allowWrite.some((allowed) =>
        _pathWithinAllow(normalizedPath, allowed),
    );

    if (!isAllowed) {
        const reason = `Write denied: path "${normalizedPath}" is not within any allowed write path`;

        _recordViolation("filesystem", "write", normalizedPath, reason);

        if (_config.mode === "audit") {
            return { allowed: true, reason };
        }

        return { allowed: false, reason };
    }

    return { allowed: true };
}

/**
 * Check if a normalized path matches a deny rule.
 * A deny rule matches if the path is equal to or is a child of the denied path.
 */
function _pathMatchesDeny(normalizedPath: string, deniedPath: string): boolean {
    const lowerPath = normalizedPath.toLowerCase();
    const lowerDenied = deniedPath.toLowerCase();

    return lowerPath === lowerDenied || lowerPath.startsWith(lowerDenied + "/");
}

/**
 * Check if a normalized path is within an allowed path.
 * The path must be equal to or a child of the allowed path.
 */
function _pathWithinAllow(normalizedPath: string, allowedPath: string): boolean {
    const lowerPath = normalizedPath.toLowerCase();
    const lowerAllowed = allowedPath.toLowerCase();

    return lowerPath === lowerAllowed || lowerPath.startsWith(lowerAllowed + "/");
}

/** Record a violation for audit/enforce mode. Caps at MAX_VIOLATIONS entries. */
function _recordViolation(
    tier: SandboxTier,
    operation: string,
    target: string,
    reason: string,
): void {
    const violation: ViolationRecord = {
        timestamp: new Date(),
        tier,
        operation,
        target,
        reason,
    };

    _violations.push(violation);

    // Ring buffer: drop oldest when over cap
    if (_violations.length > MAX_VIOLATIONS) {
        _violations = _violations.slice(-MAX_VIOLATIONS);
    }

    // Notify listeners
    for (const listener of _violationListeners) {
        try {
            listener(violation);
        } catch {
            // Listener errors must not crash the sandbox
        }
    }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Reset internal module state. Exposed for testing only.
 * @internal
 */
export function _resetState(): void {
    _config = null;
    _initialized = false;
    _initFailed = false;
    _violations = [];
    _violationListeners = [];
    _sshAuthSock = null;
}
