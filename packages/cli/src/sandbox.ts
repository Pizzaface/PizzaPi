import { homedir } from "os";
import { join, resolve } from "path";

import {
    type PizzaPiConfig,
    type SandboxConfig,
    type SandboxMode,
    type SrtConfig,
    type ResolvedSandboxConfig,
    SANDBOX_MODE_ALIASES,
} from "./config-types.js";

export {
    validateSandboxOverride,
    resolveSandboxConfig,
    mergeSandboxConfig,
};

// ── Sensitive paths blocked by all non-none presets ───────────────────────────

const SENSITIVE_DENY_READ: string[] = [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/gcloud",
    "~/.docker/config.json",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Firefox",
    "~/.mozilla/firefox",
    "~/.config/google-chrome",
    "~/.config/chromium",
];

const SENSITIVE_DENY_WRITE: string[] = [
    ".env",
    ".env.local",
    "~/.ssh",
];

// ── Preset base configs (before path resolution) ──────────────────────────────

/**
 * `basic` preset: filesystem protection, unrestricted network.
 * No `network` key → srt does not activate network sandboxing.
 */
const PRESET_BASIC: Omit<SrtConfig, "network"> = {
    filesystem: {
        denyRead: SENSITIVE_DENY_READ,
        allowWrite: [".", "/tmp"],
        denyWrite: SENSITIVE_DENY_WRITE,
    },
};

/**
 * `full` preset: filesystem protection + network deny-all by default.
 * `network.allowedDomains: []` tells srt to block all outbound network.
 * Users add domain overrides to open specific holes.
 */
const PRESET_FULL: SrtConfig = {
    network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
    },
    filesystem: {
        denyRead: SENSITIVE_DENY_READ,
        allowWrite: [".", "/tmp"],
        denyWrite: SENSITIVE_DENY_WRITE,
    },
};

/**
 * Resolve a raw sandbox override string (from CLI flag or env var) to a
 * validated `SandboxMode`.  Throws on unrecognised values so operators get
 * a clear error instead of a silent fallback to a weaker mode.
 *
 * Returns `undefined` when `raw` is `undefined`/empty (no override).
 */
function validateSandboxOverride(raw: string | undefined): SandboxMode | undefined {
    if (raw === undefined || raw === "") return undefined;
    const resolved = SANDBOX_MODE_ALIASES[raw.toLowerCase()];
    if (resolved !== undefined) return resolved;
    const validValues = [...new Set([...Object.keys(SANDBOX_MODE_ALIASES)])].join(", ");
    throw new Error(
        `Invalid sandbox override "${raw}". ` +
        `Valid values: ${validValues}. Refusing to start with unknown mode.`,
    );
}

/**
 * Coerce a raw JSON value into a `string[]` suitable for sandbox path/domain lists.
 *
 * Handles common user mistakes in config.json:
 *   - `"."` (bare string instead of array) → `["."]`
 *   - `[42, ".", null]` (non-string items) → `["."]` (non-strings filtered out)
 *   - `true` / `{}` / other non-array, non-string → `undefined` (falls back to preset)
 *
 * Returns `undefined` when the input is `undefined`/`null` so callers can
 * distinguish "not specified" from "explicitly empty".
 */
function coerceStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    // Unrecognised type (number, boolean, object) — ignore and fall back to preset
    return undefined;
}

/**
 * Sanitize a raw `SandboxConfig` from JSON, coercing array fields so that
 * downstream code can safely spread / `.map()` without `TypeError`.
 */
function sanitizeSandboxConfig(raw: SandboxConfig): SandboxConfig {
    return {
        ...raw,
        filesystem: raw.filesystem
            ? {
                  ...raw.filesystem,
                  denyRead: coerceStringArray(raw.filesystem.denyRead),
                  allowWrite: coerceStringArray(raw.filesystem.allowWrite),
                  denyWrite: coerceStringArray(raw.filesystem.denyWrite),
              }
            : undefined,
        network: raw.network
            ? {
                  ...raw.network,
                  allowedDomains: coerceStringArray(raw.network.allowedDomains),
                  deniedDomains: coerceStringArray(raw.network.deniedDomains),
                  allowUnixSockets: coerceStringArray(raw.network.allowUnixSockets),
              }
            : undefined,
    };
}

/**
 * Expand `~` to `os.homedir()` and resolve `.` to the given `cwd`.
 * Absolute paths are returned as-is (after ~ expansion).
 */
function resolveSandboxPath(p: string, cwd: string): string {
    const expanded = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    if (expanded === ".") return resolve(cwd);
    // Relative paths (not starting with /) are resolved against cwd
    if (!expanded.startsWith("/")) return resolve(cwd, expanded);
    return expanded;
}

/**
 * Resolve a partial SandboxConfig into a ResolvedSandboxConfig.
 *
 * 1. Pick the base SrtConfig from the preset (`basic` or `full`).
 * 2. Deep-merge user overrides on top (deny lists union, allow lists replace).
 * 3. Expand all paths (`~` → homedir, `.` → cwd).
 * 4. Return `{ mode: "none", srtConfig: null }` when mode is `"none"`.
 */
function resolveSandboxConfig(cwd: string, config: PizzaPiConfig): ResolvedSandboxConfig {
    const s = sanitizeSandboxConfig(config.sandbox ?? {});
    const rawMode = s.mode ?? "basic";

    // Validate mode — fail closed on unknown values to prevent silent security downgrades
    const VALID_MODES: readonly SandboxMode[] = ["none", "basic", "full"] as const;
    if (!VALID_MODES.includes(rawMode as SandboxMode)) {
        throw new Error(
            `Invalid sandbox mode "${rawMode}" in config. ` +
            `Valid values: ${VALID_MODES.join(", ")}. Refusing to start with unknown mode.`,
        );
    }
    const mode: SandboxMode = rawMode as SandboxMode;

    if (mode === "none") {
        return { mode: "none", srtConfig: null };
    }

    const resolvePaths = (paths: string[]): string[] =>
        paths.map((p) => resolveSandboxPath(p, cwd));

    // Start from the preset
    const preset: SrtConfig = mode === "full"
        ? { ...PRESET_FULL, filesystem: { ...PRESET_FULL.filesystem }, network: { ...PRESET_FULL.network! } }
        : { ...PRESET_BASIC, filesystem: { ...PRESET_BASIC.filesystem } };

    // ── Filesystem overrides ──────────────────────────────────────────────────
    // denyRead/denyWrite: union (user can add more denied paths)
    const denyRead = [
        ...preset.filesystem.denyRead,
        ...(s.filesystem?.denyRead ?? []),
    ];
    const denyWrite = [
        ...preset.filesystem.denyWrite,
        ...(s.filesystem?.denyWrite ?? []),
    ];
    // allowWrite: user value replaces preset when specified (opt-in narrowing or widening)
    const allowWrite = s.filesystem?.allowWrite ?? preset.filesystem.allowWrite;

    const filesystem: SrtConfig["filesystem"] = {
        denyRead: resolvePaths([...new Set(denyRead)]),
        allowWrite: resolvePaths(allowWrite),
        denyWrite: resolvePaths([...new Set(denyWrite)]),
        ...(s.filesystem?.allowGitConfig !== undefined
            ? { allowGitConfig: s.filesystem.allowGitConfig }
            : {}),
    };

    // ── Network overrides ─────────────────────────────────────────────────────
    // Presence of network.allowedDomains in the override activates srt network
    // sandboxing even in `basic` mode (user opted in explicitly).
    let network: SrtConfig["network"];

    if (preset.network) {
        // `full` preset: start from preset, apply overrides
        network = {
            allowedDomains: s.network?.allowedDomains ?? preset.network.allowedDomains,
            deniedDomains: [
                ...preset.network.deniedDomains,
                ...(s.network?.deniedDomains ?? []),
            ],
            allowLocalBinding: s.network?.allowLocalBinding ?? preset.network.allowLocalBinding,
            ...(s.network?.allowUnixSockets !== undefined
                ? { allowUnixSockets: s.network.allowUnixSockets }
                : {}),
            ...(s.network?.allowAllUnixSockets !== undefined
                ? { allowAllUnixSockets: s.network.allowAllUnixSockets }
                : {}),
            ...(s.network?.httpProxyPort !== undefined
                ? { httpProxyPort: s.network.httpProxyPort }
                : {}),
            ...(s.network?.socksProxyPort !== undefined
                ? { socksProxyPort: s.network.socksProxyPort }
                : {}),
        };
    } else if (s.network?.allowedDomains !== undefined) {
        // `basic` preset but user explicitly set allowedDomains → opt-in network sandboxing
        network = {
            allowedDomains: s.network.allowedDomains,
            deniedDomains: s.network.deniedDomains ?? [],
            allowLocalBinding: s.network.allowLocalBinding ?? true,
            ...(s.network.allowUnixSockets !== undefined
                ? { allowUnixSockets: s.network.allowUnixSockets }
                : {}),
            ...(s.network.allowAllUnixSockets !== undefined
                ? { allowAllUnixSockets: s.network.allowAllUnixSockets }
                : {}),
            ...(s.network.httpProxyPort !== undefined
                ? { httpProxyPort: s.network.httpProxyPort }
                : {}),
            ...(s.network.socksProxyPort !== undefined
                ? { socksProxyPort: s.network.socksProxyPort }
                : {}),
        };
    }
    // else: basic mode with no allowedDomains override → no network key → no network sandboxing

    const srtConfig: SrtConfig = {
        filesystem,
        ...(network !== undefined ? { network } : {}),
        ...(s.ignoreViolations !== undefined ? { ignoreViolations: s.ignoreViolations } : {}),
        ...(s.enableWeakerNetworkIsolation !== undefined
            ? { enableWeakerNetworkIsolation: s.enableWeakerNetworkIsolation }
            : {}),
        ...(s.enableWeakerNestedSandbox !== undefined
            ? { enableWeakerNestedSandbox: s.enableWeakerNestedSandbox }
            : {}),
        ...(s.mandatoryDenySearchDepth !== undefined
            ? { mandatoryDenySearchDepth: s.mandatoryDenySearchDepth }
            : {}),
        ...(s.allowPty !== undefined ? { allowPty: s.allowPty } : {}),
    };

    return { mode, srtConfig };
}

/**
 * Merge a global SandboxConfig with a project-local SandboxConfig.
 *
 * Security invariant: the project config CANNOT weaken the global config.
 *   - `mode`: ordered `none < basic < full`; project can only move to a stricter mode, not weaker.
 *   - `filesystem.denyRead` / `denyWrite`: union (project can add more denials, not remove).
 *   - `filesystem.allowWrite`: intersection when both are specified (project can only narrow).
 *   - `network.allowedDomains`: intersection when both are specified (project can only narrow).
 *   - `network.deniedDomains`: union (project can add more denials, not remove).
 */
function mergeSandboxConfig(rawGlobal: SandboxConfig, rawProject: SandboxConfig): SandboxConfig {
    const global = sanitizeSandboxConfig(rawGlobal);
    const project = sanitizeSandboxConfig(rawProject);

    const union = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
        const combined = [...(a ?? []), ...(b ?? [])];
        return combined.length > 0 ? [...new Set(combined)] : undefined;
    };

    const intersect = (
        g: string[] | undefined,
        p: string[] | undefined,
    ): string[] | undefined => {
        // When global is undefined, return undefined so the preset default is
        // used.  Returning `p` here would let the project-local config introduce
        // arbitrary allowlist values and widen preset protections.
        if (g === undefined) return undefined;
        if (p === undefined) return g;
        const pSet = new Set(p);
        const result = g.filter((item) => pSet.has(item));
        return result.length > 0 ? result : [];
    };

    // Mode: project can only escalate (none → basic → full)
    const modeStrength: Record<SandboxMode, number> = { none: 0, basic: 1, full: 2 };
    const globalMode: SandboxMode = global.mode ?? "basic";
    const projectMode: SandboxMode = project.mode ?? globalMode;
    const effectiveMode: SandboxMode =
        modeStrength[projectMode] >= modeStrength[globalMode] ? projectMode : globalMode;

    // For scalar fields: global wins (security invariant — project cannot weaken).
    // Helper: pick global value if defined, else use project fallback.
    const globalWins = <T>(g: T | undefined, p: T | undefined): T | undefined =>
        g !== undefined ? g : p;

    // For security-sensitive boolean flags: project cannot enable weakening when global
    // config is absent. Keep strict defaults (false for "enable weaker" options) to
    // prevent project-local config from reducing isolation strength.
    const keepStrict = (g: boolean | undefined, p: boolean | undefined): boolean | undefined => {
        // If global is set, use it (project cannot override)
        if (g !== undefined) return g;
        // If global is not set, only use project value if it maintains strict settings (false)
        return p === false ? false : undefined;
    };

    return {
        mode: effectiveMode,
        network: {
            allowedDomains: intersect(global.network?.allowedDomains, project.network?.allowedDomains),
            deniedDomains: union(global.network?.deniedDomains, project.network?.deniedDomains),
            allowLocalBinding: keepStrict(global.network?.allowLocalBinding, project.network?.allowLocalBinding),
            // Unix socket allowances: project cannot weaken
            // allowUnixSockets is a string[] allowlist — intersect so project can only narrow
            allowUnixSockets: intersect(global.network?.allowUnixSockets, project.network?.allowUnixSockets),
            // allowAllUnixSockets is a boolean weakening flag — keep strict default
            allowAllUnixSockets: keepStrict(global.network?.allowAllUnixSockets, project.network?.allowAllUnixSockets),
            // Proxy ports: global wins
            httpProxyPort: globalWins(global.network?.httpProxyPort, project.network?.httpProxyPort),
            socksProxyPort: globalWins(global.network?.socksProxyPort, project.network?.socksProxyPort),
        },
        filesystem: {
            denyRead: union(global.filesystem?.denyRead, project.filesystem?.denyRead),
            denyWrite: union(global.filesystem?.denyWrite, project.filesystem?.denyWrite),
            allowWrite: intersect(global.filesystem?.allowWrite, project.filesystem?.allowWrite),
            // allowGitConfig: must keep strict (false) default when global not set
            allowGitConfig: keepStrict(global.filesystem?.allowGitConfig, project.filesystem?.allowGitConfig),
        },
        // Top-level scalar fields: different rules per field type
        // ignoreViolations: global-only — project cannot suppress srt violation enforcement
        ignoreViolations: global.ignoreViolations,
        // Weaker-isolation flags must keep strict (false) default when no global config exists
        enableWeakerNetworkIsolation: keepStrict(global.enableWeakerNetworkIsolation, project.enableWeakerNetworkIsolation),
        enableWeakerNestedSandbox: keepStrict(global.enableWeakerNestedSandbox, project.enableWeakerNestedSandbox),
        // mandatoryDenySearchDepth: global-only — project cannot control search depth
        mandatoryDenySearchDepth: global.mandatoryDenySearchDepth,
        allowPty: keepStrict(global.allowPty, project.allowPty),
    };
}
