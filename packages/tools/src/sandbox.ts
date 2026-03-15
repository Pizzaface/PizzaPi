/**
 * Sandbox Manager Wrapper Module
 *
 * Thin wrapper around @anthropic-ai/sandbox-runtime's SandboxManager.
 * Provides a clean API for all PizzaPi integration points.
 *
 * @module
 */

import { resolve as pathResolve, dirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { platform } from "node:os";
import {
    SandboxManager,
    type SandboxRuntimeConfig,
    getDefaultWritePaths,
} from "@anthropic-ai/sandbox-runtime";

/** Whether the current platform is case-insensitive (macOS, Windows). */
const _caseInsensitiveFS = platform() === "darwin" || platform() === "win32";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Resolved sandbox config from the CLI config module.
 * Re-declared here to avoid a cross-package dependency on @pizzapi/cli.
 * The worker session passes this in at init time.
 */
export interface ResolvedSandboxConfig {
    /** Sandbox mode preset. */
    mode: "none" | "basic" | "full";
    /**
     * Fully-resolved srt config to pass to SandboxManager.initialize().
     * Null when mode is "none".
     */
    srtConfig: {
        network?: {
            allowedDomains: string[];
            deniedDomains: string[];
            allowLocalBinding?: boolean;
            allowUnixSockets?: string[];
            allowAllUnixSockets?: boolean;
            httpProxyPort?: number;
            socksProxyPort?: number;
        };
        filesystem: {
            denyRead: string[];
            allowWrite: string[];
            denyWrite: string[];
            allowGitConfig?: boolean;
        };
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNetworkIsolation?: boolean;
        enableWeakerNestedSandbox?: boolean;
        mandatoryDenySearchDepth?: number;
        allowPty?: boolean;
    } | null;
}

/** Result of a path validation check. */
export interface ValidationResult {
    allowed: boolean;
    reason?: string;
}

/** A record of a sandbox violation. */
export interface ViolationRecord {
    timestamp: Date;
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
let _readOnlyOverlay = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the sandbox. Call once per worker session.
 *
 * Translates `ResolvedSandboxConfig.srtConfig` into the `SandboxRuntimeConfig`
 * expected by `SandboxManager` and calls `SandboxManager.initialize()`.
 *
 * Graceful degradation:
 * - Mode `"none"` or null srtConfig: skips initialization entirely.
 * - Unsupported platforms (Windows): logs a warning and continues unsandboxed.
 * - If `SandboxManager.initialize()` throws: logs the error and continues
 *   unsandboxed. Never crashes the worker.
 */
export async function initSandbox(config: ResolvedSandboxConfig): Promise<void> {
    _config = config;
    _violations = [];
    _initFailed = false;

    // Mode "none" or no srtConfig → no sandbox
    if (config.mode === "none" || config.srtConfig === null) {
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

    // Build the SandboxRuntimeConfig to pass to srt
    const runtimeConfig = _buildSrtConfig(config);

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
 * Wrap a shell command with sandbox restrictions.
 *
 * Returns the srt-wrapped command when sandboxing is active.
 * Returns the original command when sandbox is off or init failed.
 */
export async function wrapCommand(cmd: string): Promise<string> {
    if (!_isActive()) {
        return cmd;
    }

    try {
        // When read-only overlay is active (plan mode), wrap with a config
        // that denies all filesystem writes. The OS enforces this regardless
        // of what command is run — no command parsing needed.
        const customConfig = _readOnlyOverlay
            ? { filesystem: { allowWrite: [] as string[], denyWrite: ["/"], denyRead: [] as string[] } }
            : undefined;
        return await SandboxManager.wrapWithSandbox(cmd, undefined, customConfig);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fail closed: block the command rather than run it unsandboxed.
        console.error(`[sandbox] Failed to wrap command, blocking: ${msg}`);
        throw new Error(`Sandbox enforcement failed: ${msg}`);
    }
}

/**
 * Validate a path for read or write operations.
 *
 * Uses the resolved filesystem deny/allow lists for pre-call validation.
 * This provides a fast, user-friendly error before the OS-level enforcement
 * fires (which would produce a less informative EPERM).
 */
export function validatePath(
    filePath: string,
    op: "read" | "write",
): ValidationResult {
    if (!_config || _config.mode === "none" || !_config.srtConfig) {
        return { allowed: true };
    }

    const normalizedPath = _normalizePath(filePath);

    return op === "read"
        ? _validateReadPath(normalizedPath)
        : _validateWritePath(normalizedPath);
}

/**
 * Get proxy environment variables for sandboxed child processes.
 *
 * Returns HTTP_PROXY / HTTPS_PROXY / ALL_PROXY when the srt network proxy
 * is active; otherwise returns an empty object.
 */
export function getSandboxEnv(): Record<string, string> {
    if (!_isActive()) {
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
 */
export function isSandboxActive(): boolean {
    return _isActive();
}

/**
 * Enable or disable the read-only filesystem overlay.
 *
 * When enabled, `wrapCommand` wraps all commands with a sandbox config that
 * denies all filesystem writes (allowWrite: [], denyWrite: ["/"]).
 * Used by plan mode to enforce read-only exploration without parsing commands.
 *
 * Only effective when sandbox is active. When sandbox is inactive, this is a
 * no-op — callers should check `isSandboxActive()` and use a fallback.
 */
export function setReadOnlyOverlay(enabled: boolean): void {
    _readOnlyOverlay = enabled;
}

/**
 * Check if the read-only overlay is currently active.
 */
export function isReadOnlyOverlay(): boolean {
    return _readOnlyOverlay;
}

/**
 * Get the current sandbox mode, or `"none"` if not initialized.
 */
export function getSandboxMode(): "none" | "basic" | "full" {
    return _config?.mode ?? "none";
}

/**
 * Get all recorded violations.
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
 * Cleanup sandbox resources. Safe to call even if never initialized.
 */
export async function cleanupSandbox(): Promise<void> {
    if (_initialized && !_initFailed && _config?.mode !== "none" && _config?.srtConfig !== null) {
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
    _readOnlyOverlay = false;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Build the SandboxRuntimeConfig to pass to srt from our resolved config. */
function _buildSrtConfig(config: ResolvedSandboxConfig): SandboxRuntimeConfig {
    const srt = config.srtConfig!;

    // Merge SSH agent socket into allowUnixSockets if detected
    let allowUnixSockets = srt.network?.allowUnixSockets;
    if (_sshAuthSock && srt.network) {
        const existing = allowUnixSockets ?? [];
        if (!existing.includes(_sshAuthSock)) {
            allowUnixSockets = [...existing, _sshAuthSock];
        }
    }

    return {
        filesystem: {
            denyRead: srt.filesystem.denyRead,
            allowWrite: [
                ...getDefaultWritePaths(),
                ...srt.filesystem.allowWrite,
            ],
            denyWrite: srt.filesystem.denyWrite,
            ...(srt.filesystem.allowGitConfig !== undefined
                ? { allowGitConfig: srt.filesystem.allowGitConfig }
                : {}),
        },
        // Only include `network` when srt.network is defined (full mode or
        // basic-mode with explicit allowedDomains opt-in).  Omitting it in
        // basic mode tells the sandbox runtime to skip network restrictions
        // entirely — `allowedDomains: []` would be interpreted as "block all
        // outbound traffic", which is NOT the intent for basic mode.
        ...(srt.network !== undefined
            ? {
                network: {
                    allowedDomains: srt.network.allowedDomains,
                    deniedDomains: srt.network.deniedDomains,
                    allowLocalBinding: srt.network.allowLocalBinding,
                    ...(allowUnixSockets !== undefined ? { allowUnixSockets } : {}),
                    ...(srt.network.allowAllUnixSockets !== undefined
                        ? { allowAllUnixSockets: srt.network.allowAllUnixSockets }
                        : {}),
                    ...(srt.network.httpProxyPort !== undefined
                        ? { httpProxyPort: srt.network.httpProxyPort }
                        : {}),
                    ...(srt.network.socksProxyPort !== undefined
                        ? { socksProxyPort: srt.network.socksProxyPort }
                        : {}),
                },
            }
            : {}),
        ...(srt.ignoreViolations !== undefined
            ? { ignoreViolations: srt.ignoreViolations }
            : {}),
        ...(srt.enableWeakerNetworkIsolation !== undefined
            ? { enableWeakerNetworkIsolation: srt.enableWeakerNetworkIsolation }
            : {}),
        ...(srt.enableWeakerNestedSandbox !== undefined
            ? { enableWeakerNestedSandbox: srt.enableWeakerNestedSandbox }
            : {}),
        ...(srt.mandatoryDenySearchDepth !== undefined
            ? { mandatoryDenySearchDepth: srt.mandatoryDenySearchDepth }
            : {}),
        ...(srt.allowPty !== undefined ? { allowPty: srt.allowPty } : {}),
    } as SandboxRuntimeConfig;
}

/** Returns true when the sandbox is initialized and active (not none/failed). */
function _isActive(): boolean {
    return _initialized && !_initFailed && _config?.mode !== "none" && _config?.srtConfig !== null;
}

/** Normalize a file path for comparison against config paths. */
function _normalizePath(filePath: string): string {
    let expanded = filePath;
    if (expanded.startsWith("~")) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
        expanded = home + expanded.slice(1);
    }
    const resolved = pathResolve(expanded);

    try {
        if (existsSync(resolved)) {
            return realpathSync(resolved);
        }
        let parent = dirname(resolved);
        const tail: string[] = [resolved.slice(parent.length)];
        while (parent !== "/" && !existsSync(parent)) {
            const next = dirname(parent);
            tail.unshift(parent.slice(next.length));
            parent = next;
        }
        if (existsSync(parent)) {
            return realpathSync(parent) + tail.join("");
        }
    } catch {
        // realpath can throw on broken symlinks or permissions — fall through
    }
    return resolved;
}

/** Normalize a config rule path (same logic as _normalizePath). */
function _normalizeRulePath(rulePath: string): string {
    let expanded = rulePath;
    if (expanded.startsWith("~")) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
        expanded = home + expanded.slice(1);
    }
    let resolved = pathResolve(expanded);
    while (resolved.length > 1 && resolved.endsWith("/")) {
        resolved = resolved.slice(0, -1);
    }
    try {
        if (existsSync(resolved)) {
            return realpathSync(resolved);
        }
        let parent = dirname(resolved);
        const tail: string[] = [resolved.slice(parent.length)];
        while (parent !== "/" && !existsSync(parent)) {
            const next = dirname(parent);
            tail.unshift(parent.slice(next.length));
            parent = next;
        }
        if (existsSync(parent)) {
            return realpathSync(parent) + tail.join("");
        }
    } catch {
        // Fall through
    }
    return resolved;
}

/** Check if a normalized path is denied for reading. */
function _validateReadPath(normalizedPath: string): ValidationResult {
    const fs = _config?.srtConfig?.filesystem;
    if (!fs) return { allowed: true };

    for (const denied of fs.denyRead) {
        if (_pathMatchesDeny(normalizedPath, denied)) {
            const reason = `Read denied: path "${normalizedPath}" matches deny rule "${denied}"`;
            _recordViolation("read", normalizedPath, reason);
            return { allowed: false, reason };
        }
    }

    return { allowed: true };
}

/** Check if a normalized path is permitted for writing. */
function _validateWritePath(normalizedPath: string): ValidationResult {
    const fs = _config?.srtConfig?.filesystem;
    if (!fs) return { allowed: true };

    // denyWrite takes precedence
    for (const denied of fs.denyWrite) {
        if (_pathMatchesDeny(normalizedPath, denied)) {
            const reason = `Write denied: path "${normalizedPath}" matches deny rule "${denied}"`;
            _recordViolation("write", normalizedPath, reason);
            return { allowed: false, reason };
        }
    }

    // Must be within an allowWrite path
    const isAllowed = fs.allowWrite.some((allowed) =>
        _pathWithinAllow(normalizedPath, allowed),
    );

    if (!isAllowed) {
        const reason = `Write denied: path "${normalizedPath}" is not within any allowed write path`;
        _recordViolation("write", normalizedPath, reason);
        return { allowed: false, reason };
    }

    return { allowed: true };
}

function _pathsEqual(a: string, b: string): boolean {
    return _caseInsensitiveFS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function _pathStartsWith(path: string, prefix: string): boolean {
    return _caseInsensitiveFS
        ? path.toLowerCase().startsWith(prefix.toLowerCase())
        : path.startsWith(prefix);
}

function _pathMatchesDeny(normalizedPath: string, deniedPath: string): boolean {
    const rule = _normalizeRulePath(deniedPath);
    // When the rule is "/" (filesystem root), every absolute path is a child.
    // Appending "/" naively would produce "//" which never matches.
    const prefix = rule === "/" ? "/" : rule + "/";
    return _pathsEqual(normalizedPath, rule) || _pathStartsWith(normalizedPath, prefix);
}

function _pathWithinAllow(normalizedPath: string, allowedPath: string): boolean {
    const rule = _normalizeRulePath(allowedPath);
    const prefix = rule === "/" ? "/" : rule + "/";
    return _pathsEqual(normalizedPath, rule) || _pathStartsWith(normalizedPath, prefix);
}

/** Record a violation. Caps at MAX_VIOLATIONS entries. */
function _recordViolation(operation: string, target: string, reason: string): void {
    const violation: ViolationRecord = {
        timestamp: new Date(),
        operation,
        target,
        reason,
    };

    _violations.push(violation);
    if (_violations.length > MAX_VIOLATIONS) {
        _violations = _violations.slice(-MAX_VIOLATIONS);
    }

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
    _readOnlyOverlay = false;
}
