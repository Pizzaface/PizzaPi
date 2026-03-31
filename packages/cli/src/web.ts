/**
 * `pizza web` — Start the PizzaPi web hub (server + UI) using Docker Compose.
 *
 * Usage:
 *   pizza web                  Start the hub (default port 7492)
 *   pizza web --tag main       Pull and use ghcr.io/pizzaface/pizzapi-ui:main
 *   pizza web --build          Build UI locally (fallback mode)
 *   pizza web --dev-ui         Run the local dev UI stack (local repo only)
 *   pizza web --port 8080      Start on a custom port (persisted)
 *   pizza web stop             Stop the hub
 *   pizza web logs             Tail logs
 *   pizza web status           Show running status
 *   pizza web config           Show current configuration
 *   pizza web config set <key> <value>   Set a config value
 *   pizza web --help           Show help
 */

import { execFileSync, spawn } from "child_process";
import { createECDH, createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir, arch } from "os";
import { c } from "./cli-colors.js";
import { createLogger } from "@pizzapi/tools";
import { createRequire } from "module";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebConfig {
    /** Host port to expose the web UI on */
    port: number;
    /** VAPID key pair for web push notifications */
    vapid: { publicKey: string; privateKey: string };
    /** VAPID subject (mailto: or https:) */
    vapidSubject: string;
    /** Comma-separated extra allowed origins for CORS */
    extraOrigins: string;
    /** Secret key used by better-auth for session signing (persisted). */
    betterAuthSecret: string;
    /** Whether to trust X-Forwarded-For headers from a reverse proxy (persisted). */
    trustProxy?: boolean;
    /** Number of trusted proxy hops for X-Forwarded-For (persisted). */
    proxyDepth?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEB_DIR = join(homedir(), ".pizzapi", "web");
const CONFIG_PATH = join(WEB_DIR, "config.json");
const HOST_BUILD_STATE_PATH = join(WEB_DIR, "host-build.json");
const REPO_URL = "https://github.com/Pizzaface/PizzaPi.git";
const UI_IMAGE_REPOSITORY = "ghcr.io/pizzaface/pizzapi-ui";
const log = createLogger("web");

interface HostBuildState {
    lastLockHash?: string | null;
    lastUiSignature?: string | null;
}

function loadHostBuildState(): HostBuildState {
    try {
        return JSON.parse(readFileSync(HOST_BUILD_STATE_PATH, "utf-8"));
    } catch {
        return {};
    }
}

function saveHostBuildState(state: HostBuildState): void {
    mkdirSync(WEB_DIR, { recursive: true });
    writeFileSync(HOST_BUILD_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function hashFile(path: string): string | null {
    try {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
        return null;
    }
}

/**
 * Compute a short content hash of the UI dist/ directory for Docker cache-busting.
 * Uses the .build-stamp file (written on every prebuild) as a fast proxy —
 * if it's missing, falls back to hashing the index.html.
 */
function computeDistHash(distDir: string): string {
    const stampPath = join(distDir, ".build-stamp");
    const indexPath = join(distDir, "index.html");
    try {
        const content = existsSync(stampPath)
            ? readFileSync(stampPath, "utf-8")
            : readFileSync(indexPath, "utf-8");
        return createHash("sha256").update(content).digest("hex").slice(0, 12);
    } catch {
        // Fallback: unique per invocation so Docker always rebuilds
        return Date.now().toString(36);
    }
}

function computeUiSignature(repoPath: string): string | null {
    try {
        const head = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
        const status = execFileSync(
            "git",
            ["-C", repoPath, "status", "--short", "packages/ui", "packages/protocol"],
            { encoding: "utf-8" }
        ).trim();
        const lockHash = hashFile(join(repoPath, "bun.lock")) ?? "";
        return createHash("sha256").update(head).update("\n").update(status).update("\n").update(lockHash).digest("hex");
    } catch {
        return null;
    }
}

export function shouldInstallDependencies(opts: {
    nodeModulesPresent: boolean;
    currentLockHash: string | null;
    lastLockHash: string | null | undefined;
}): boolean {
    if (!opts.nodeModulesPresent) return true;
    if (!opts.currentLockHash) return false;
    return opts.currentLockHash !== (opts.lastLockHash ?? null);
}

export function shouldRebuildHostUi(opts: {
    distReady: boolean;
    currentSignature: string | null;
    lastSignature: string | null | undefined;
}): boolean {
    if (!opts.distReady) return true;
    if (!opts.currentSignature) return true;
    return opts.currentSignature !== (opts.lastSignature ?? null);
}

export function readBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return defaultValue;
}

// ─── VAPID key generation ─────────────────────────────────────────────────────

function generateVapidKeys(): { publicKey: string; privateKey: string } {
    const curve = createECDH("prime256v1");
    curve.generateKeys();
    const toUrlBase64 = (buf: Buffer) =>
        buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return {
        publicKey: toUrlBase64(curve.getPublicKey() as Buffer),
        privateKey: toUrlBase64(curve.getPrivateKey() as Buffer),
    };
}

function generateBetterAuthSecret(): string {
    // 32 bytes (~256 bits) encoded as base64url, suitable for env vars.
    return randomBytes(32)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

// ─── Config management ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WebConfig = {
    port: 7492,
    vapid: { publicKey: "", privateKey: "" },
    vapidSubject: "mailto:admin@pizzapi.local",
    extraOrigins: "",
    betterAuthSecret: "",
};

/** Settings that can be extracted from an existing compose.yml */
export interface ExtractedComposeSettings {
    vapid?: { publicKey: string; privateKey: string };
    vapidSubject?: string;
    extraOrigins?: string;
    port?: number;
    betterAuthSecret?: string;
    trustProxy?: boolean;
    proxyDepth?: number;
}

/**
 * Match an environment variable from compose YAML content.
 * Supports three formats:
 *   1. List form: `- KEY=value`
 *   2. YAML mapping form: `KEY: "value"` or `KEY: value` (indented, inside environment block)
 *   3. Bare form: `KEY=value` (no prefix, used in simpler/partial compose snippets)
 * For mapping form, strips surrounding quotes from the value.
 * Returns null if the key is not found or is commented out.
 */
function matchEnvVar(content: string, key: string): string | null {
    const normalizeValue = (raw: string): string => {
        let val = raw.replace(/\s+#.*$/, "").trim();
        // Strip surrounding quotes (both single and double)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        return val;
    };

    // List form: `- KEY=value` (non-commented)
    const listRegex = new RegExp(`^\\s*-\\s+${key}=(.+)`, "m");
    const listMatch = content.match(listRegex);
    if (listMatch?.[1]) {
        return normalizeValue(listMatch[1]);
    }

    // YAML mapping form: `KEY: "value"` or `KEY: value` (non-commented)
    // The key must be indented (part of an environment block)
    const mapRegex = new RegExp(`^\\s+${key}:\\s+(.+)`, "m");
    const mapMatch = content.match(mapRegex);
    if (mapMatch?.[1]) {
        return normalizeValue(mapMatch[1]);
    }

    // Bare form fallback: `KEY=value` on a non-commented line (no list/mapping prefix).
    // Match lines where KEY= appears and the line doesn't start with optional whitespace + #.
    const bareRegex = new RegExp(`^(?!\\s*#).*${key}=(.+)`, "m");
    const bareMatch = content.match(bareRegex);
    if (bareMatch?.[1]) {
        return normalizeValue(bareMatch[1]);
    }

    return null;
}

/** Extract all user settings from compose.yml content (pure function, exported for testing) */
export function extractSettingsFromCompose(content: string): ExtractedComposeSettings {
    const result: ExtractedComposeSettings = {};

    // VAPID keys
    const pub = matchEnvVar(content, "VAPID_PUBLIC_KEY");
    const priv = matchEnvVar(content, "VAPID_PRIVATE_KEY");
    if (pub && priv) {
        // Skip template placeholders
        if (!pub.startsWith("{{")) {
            result.vapid = { publicKey: pub, privateKey: priv };
        }
    }

    // VAPID subject
    const subject = matchEnvVar(content, "VAPID_SUBJECT");
    if (subject && !subject.startsWith("{{")) {
        result.vapidSubject = subject;
    }

    // better-auth secret
    const secret = matchEnvVar(content, "BETTER_AUTH_SECRET");
    if (secret && !secret.startsWith("{{")) {
        result.betterAuthSecret = secret;
    }

    // Extra origins (skip commented-out lines)
    const origins = matchEnvVar(content, "PIZZAPI_EXTRA_ORIGINS");
    if (origins && !origins.startsWith("{{") && origins.length > 0) {
        result.extraOrigins = origins;
    }

    // Port from the host:container mapping (e.g. "8080:7492")
    const portMatch = content.match(/"(\d+):7492"/);
    if (portMatch?.[1]) {
        const p = parseInt(portMatch[1], 10);
        if (!isNaN(p) && p > 0 && p <= 65535) {
            result.port = p;
        }
    }

    // Trust proxy setting
    const trustProxyVal = matchEnvVar(content, "PIZZAPI_TRUST_PROXY");
    if (trustProxyVal) {
        const lower = trustProxyVal.toLowerCase();
        if (lower === "true") result.trustProxy = true;
        else if (lower === "false") result.trustProxy = false;
    }

    // Proxy depth setting
    const proxyDepthVal = matchEnvVar(content, "PIZZAPI_PROXY_DEPTH");
    if (proxyDepthVal) {
        const val = parseInt(proxyDepthVal, 10);
        if (!isNaN(val) && val >= 1) result.proxyDepth = val;
    }

    return result;
}

export function resolveBetterAuthSecret(opts: {
    currentSecret: string | undefined;
    composeContents: Array<string | null | undefined>;
    generate?: () => string;
}): { secret: string; source: "existing" | "compose" | "generated" } {
    if (opts.currentSecret) {
        return { secret: opts.currentSecret, source: "existing" };
    }

    for (const content of opts.composeContents) {
        if (!content) continue;
        const extracted = extractSettingsFromCompose(content);
        if (extracted.betterAuthSecret) {
            return { secret: extracted.betterAuthSecret, source: "compose" };
        }
    }

    const gen = opts.generate ?? generateBetterAuthSecret;
    return { secret: gen(), source: "generated" };
}

export function resolveMissingProxySettings(opts: {
    currentTrustProxy: boolean | undefined;
    currentProxyDepth: number | undefined;
    composeContents: Array<string | null | undefined>;
}): { trustProxy: boolean | undefined; proxyDepth: number | undefined; source: "existing" | "compose" } {
    let trustProxy = opts.currentTrustProxy;
    let proxyDepth = opts.currentProxyDepth;

    if (trustProxy !== undefined && proxyDepth !== undefined) {
        return { trustProxy, proxyDepth, source: "existing" };
    }

    for (const content of opts.composeContents) {
        if (!content) continue;
        const extracted = extractSettingsFromCompose(content);

        if (trustProxy === undefined && extracted.trustProxy !== undefined) {
            trustProxy = extracted.trustProxy;
        }

        if (proxyDepth === undefined && extracted.proxyDepth !== undefined) {
            proxyDepth = extracted.proxyDepth;
        }

        if (trustProxy !== undefined && proxyDepth !== undefined) {
            break;
        }
    }

    const source: "existing" | "compose" =
        trustProxy !== opts.currentTrustProxy || proxyDepth !== opts.currentProxyDepth
            ? "compose"
            : "existing";

    return { trustProxy, proxyDepth, source };
}

/** @deprecated Use extractSettingsFromCompose instead */
export function extractVapidFromCompose(content: string): { publicKey: string; privateKey: string } | null {
    return extractSettingsFromCompose(content).vapid ?? null;
}

/** Migrate all settings from legacy vapid.json and/or existing compose.yml */
function migrateLegacySettings(): Partial<WebConfig> {
    const migrated: Partial<WebConfig> = {};
    const sources: string[] = [];

    // 1. Check for vapid.json (from previous version of this code)
    const vapidJsonPath = join(WEB_DIR, "vapid.json");
    if (existsSync(vapidJsonPath)) {
        try {
            const stored = JSON.parse(readFileSync(vapidJsonPath, "utf-8"));
            if (stored.publicKey && stored.privateKey) {
                migrated.vapid = stored;
                sources.push("vapid.json");
            }
        } catch { /* corrupted */ }
    }

    // 2. Extract all settings from existing compose.yml
    const composePath = join(WEB_DIR, "compose.yml");
    if (existsSync(composePath)) {
        try {
            const extracted = extractSettingsFromCompose(readFileSync(composePath, "utf-8"));

            // VAPID keys (vapid.json takes priority if present)
            if (!migrated.vapid && extracted.vapid) {
                migrated.vapid = extracted.vapid;
                sources.push("compose.yml (vapid)");
            }

            // Other settings from compose.yml
            if (extracted.vapidSubject) {
                migrated.vapidSubject = extracted.vapidSubject;
                sources.push("compose.yml (vapidSubject)");
            }
            if (extracted.extraOrigins) {
                migrated.extraOrigins = extracted.extraOrigins;
                sources.push("compose.yml (extraOrigins)");
            }
            if (extracted.port) {
                migrated.port = extracted.port;
                sources.push("compose.yml (port)");
            }
            if (extracted.betterAuthSecret) {
                migrated.betterAuthSecret = extracted.betterAuthSecret;
                sources.push("compose.yml (betterAuthSecret)");
            }
            if (extracted.trustProxy != null) {
                migrated.trustProxy = extracted.trustProxy;
                sources.push("compose.yml (trustProxy)");
            }
            if (extracted.proxyDepth != null) {
                migrated.proxyDepth = extracted.proxyDepth;
                sources.push("compose.yml (proxyDepth)");
            }
        } catch { /* can't read */ }
    }

    if (sources.length > 0) {
        log.info(`Migrated settings from ${sources.join(", ")} → config.json`);
    }

    return migrated;
}

/** Load config from disk, migrating from legacy formats if needed */
export function loadWebConfig(): WebConfig {
    mkdirSync(WEB_DIR, { recursive: true });

    if (existsSync(CONFIG_PATH)) {
        try {
            const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
            // Merge with defaults so new fields get default values
            const config: WebConfig = { ...DEFAULT_CONFIG, ...stored };

            const composePath = join(WEB_DIR, "compose.yml");
            const overridePath = join(WEB_DIR, "compose.override.yml");

            const overrideContent = existsSync(overridePath) ? readFileSync(overridePath, "utf-8") : null;
            const composeContent = existsSync(composePath) ? readFileSync(composePath, "utf-8") : null;

            // Ensure required secrets exist (migrate older configs)
            let changed = false;
            if (!config.betterAuthSecret) {
                const resolved = resolveBetterAuthSecret({
                    currentSecret: config.betterAuthSecret,
                    composeContents: [overrideContent, composeContent],
                });

                config.betterAuthSecret = resolved.secret;
                changed = true;
            }

            // Backfill newly introduced proxy settings from existing compose files
            // when upgrading from older config.json versions.
            const resolvedProxySettings = resolveMissingProxySettings({
                currentTrustProxy: config.trustProxy,
                currentProxyDepth: config.proxyDepth,
                composeContents: [overrideContent, composeContent],
            });

            if (resolvedProxySettings.trustProxy !== config.trustProxy) {
                config.trustProxy = resolvedProxySettings.trustProxy;
                changed = true;
            }

            if (resolvedProxySettings.proxyDepth !== config.proxyDepth) {
                config.proxyDepth = resolvedProxySettings.proxyDepth;
                changed = true;
            }

            if (changed) {
                saveWebConfig(config);
            }

            return config;
        } catch {
            log.warn("Warning: config.json is corrupted, using defaults.");
        }
    }

    // First run or corrupted — build config from legacy sources
    const config: WebConfig = { ...DEFAULT_CONFIG };

    const legacy = migrateLegacySettings();
    if (legacy.vapid) {
        config.vapid = legacy.vapid;
    } else {
        config.vapid = generateVapidKeys();
        log.info("Generated new VAPID keys for push notifications.");
    }
    if (legacy.vapidSubject) config.vapidSubject = legacy.vapidSubject;
    if (legacy.extraOrigins) config.extraOrigins = legacy.extraOrigins;
    if (legacy.port) config.port = legacy.port;
    if (legacy.trustProxy != null) config.trustProxy = legacy.trustProxy;
    if (legacy.proxyDepth != null) config.proxyDepth = legacy.proxyDepth;

    if (legacy.betterAuthSecret) {
        config.betterAuthSecret = legacy.betterAuthSecret;
    } else {
        config.betterAuthSecret = generateBetterAuthSecret();
        log.info("Generated BETTER_AUTH_SECRET for authentication.");
    }

    saveWebConfig(config);
    return config;
}

/** Save config to disk */
export function saveWebConfig(config: WebConfig): void {
    mkdirSync(WEB_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

function ensureDocker(): void {
    try {
        execFileSync("docker", ["--version"], { stdio: "ignore" });
        execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    } catch {
        log.error(
            "Error: Docker with Compose is required for `pizza web`.\n" +
            "Install Docker Desktop: https://docs.docker.com/get-docker/\n"
        );
        process.exit(1);
    }
}

// ─── Repo discovery ───────────────────────────────────────────────────────────

export function findRepoRoot(): string | null {
    // Search up from both the binary's own directory (works in dev / bun src/index.ts)
    // AND from the current working directory (works when `pizza web` is run from inside
    // a cloned repo while the binary itself is a global install).
    const startDirs = [import.meta.dirname ?? __dirname, process.cwd()];
    for (const startDir of startDirs) {
        let dir = startDir;
        for (let i = 0; i < 10; i++) {
            if (
                existsSync(join(dir, "Dockerfile")) &&
                existsSync(join(dir, "docker", "compose.yml"))
            ) {
                return dir;
            }
            const parent = join(dir, "..");
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null;
}

function getRepoPath(): string {
    const repoRoot = findRepoRoot();
    if (repoRoot) return repoRoot;

    const clonedRepo = join(WEB_DIR, "repo");
    if (existsSync(join(clonedRepo, "Dockerfile"))) {
        log.info("Updating PizzaPi repository...");
        try {
            execFileSync("git", ["pull", "--rebase"], { cwd: clonedRepo, stdio: "inherit" });
        } catch {
            log.warn("Warning: Could not update repo, using existing version.");
        }
        return clonedRepo;
    }

    log.info("Cloning PizzaPi repository...");
    mkdirSync(WEB_DIR, { recursive: true });
    try {
        execFileSync("git", ["clone", "--depth", "1", REPO_URL, clonedRepo], { stdio: "inherit" });
    } catch {
        log.error(
            "Error: Failed to clone the PizzaPi repository.\n\n" +
            "You can clone it manually:\n" +
            `  git clone ${REPO_URL} ${clonedRepo}\n\n` +
            "Then run `pizza web` again."
        );
        process.exit(1);
    }

    return clonedRepo;
}

// ─── Platform detection ───────────────────────────────────────────────────────

/**
 * Map Node.js process.arch values to Docker platform strings.
 * Defaults to linux/amd64 for unknown architectures.
 */
export function getDockerPlatform(nodeArch: string = arch()): string {
    switch (nodeArch) {
        case "arm64": return "linux/arm64";
        case "x64":   return "linux/amd64";
        case "arm":   return "linux/arm/v7";
        default:      return "linux/amd64";
    }
}

// ─── Compose template ─────────────────────────────────────────────────────────

// Inline the compose template so it works inside compiled Bun binaries
// where /$bunfs/root/ has no access to external files.
const COMPOSE_TEMPLATE = `# Auto-generated by \`pizza web\` — regenerated on each run.
# For custom overrides, create a compose.override.yml next to this file.
services:
  redis:
    image: redis:7-alpine
{{REDIS_PLATFORM_LINE}}    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

{{APP_SERVICE_BLOCK}}{{VOLUMES_SECTION}}`;

// ─── Host-side UI pre-build ──────────────────────────────────────────────────

export interface PrebuildResult {
    /** Whether a pre-built dist/ is ready for Docker to copy */
    prebuilt: boolean;
    /** Whether a build was actually performed (vs. cache hit) */
    rebuilt: boolean;
    /** Content hash of dist/ for Docker cache-busting (only set when prebuilt=true) */
    distHash?: string;
}

/**
 * Attempt to build the UI on the host using bun (native speed, ~15s) instead
 * of inside Docker (minutes on Docker Desktop VMs).  Returns a result object
 * indicating whether the dist is ready and whether a rebuild occurred.
 *
 * Gracefully falls back to { prebuilt: false } when:
 *   - `bun` is not on PATH (e.g. npm-installed binary without bun)
 *   - `bun install` or `bun run build` fails for any reason
 */
function prebuildUI(repoPath: string): PrebuildResult {
    const uiDist = join(repoPath, "packages", "ui", "dist");
    const uiDistIndex = join(uiDist, "index.html");
    const nodeModulesPath = join(repoPath, "node_modules");
    const protocolDist = join(repoPath, "packages", "protocol", "dist");

    try {
        execFileSync("bun", ["--version"], { stdio: "ignore" });
    } catch {
        log.info("bun not found on host — UI will be built inside Docker (slower).");
        return { prebuilt: false, rebuilt: false };
    }

    log.info("Pre-building UI on host for faster Docker build...");

    const state = loadHostBuildState();
    let stateDirty = false;

    const lockHash = hashFile(join(repoPath, "bun.lock"));
    const needsInstall = shouldInstallDependencies({
        nodeModulesPresent: existsSync(nodeModulesPath),
        currentLockHash: lockHash,
        lastLockHash: state.lastLockHash,
    });

    try {
        if (needsInstall) {
            log.info("  Installing dependencies (bun install)...");
            execFileSync("bun", ["install"], { cwd: repoPath, stdio: "inherit" });
            state.lastLockHash = lockHash ?? null;
            stateDirty = true;
        }

        const uiSignature = computeUiSignature(repoPath);
        const distReady = existsSync(uiDistIndex);
        const needsUiBuild = shouldRebuildHostUi({
            distReady,
            currentSignature: uiSignature,
            lastSignature: state.lastUiSignature,
        });

        if (!needsUiBuild && distReady) {
            log.info("  Host UI build is up to date (reusing dist/).");
            if (stateDirty) saveHostBuildState(state);
            return { prebuilt: true, rebuilt: false, distHash: computeDistHash(uiDist) };
        }

        // Explicitly clean dist/ before building to prevent stale artifacts.
        // Vite's emptyOutDir should handle this, but on macOS Docker Desktop
        // the filesystem bridge (virtiofs/gRPC-FUSE) can miss subtle changes.
        // Belt-and-suspenders: nuke it ourselves.
        if (existsSync(uiDist)) {
            log.info("  Cleaning old dist/...");
            rmSync(uiDist, { recursive: true, force: true });
        }

        log.info("  Building protocol...");
        execFileSync("bun", ["run", "build:protocol"], { cwd: repoPath, stdio: "inherit" });

        log.info("  Building UI...");
        execFileSync("bun", ["run", "build:ui"], { cwd: repoPath, stdio: "inherit" });

        if (existsSync(uiDistIndex)) {
            // Write a cache-busting stamp so Docker's COPY layer always
            // detects the rebuild, even if Vite produced byte-identical output.
            writeBuildStamp(uiDist);

            log.info("  ✓ UI pre-built successfully.");
            if (uiSignature) {
                state.lastUiSignature = uiSignature;
                stateDirty = true;
            }
            if (stateDirty) saveHostBuildState(state);
            return { prebuilt: true, rebuilt: true, distHash: computeDistHash(uiDist) };
        }
    } catch (err) {
        log.warn("Warning: Host UI build failed, falling back to Docker build.");
        if (err instanceof Error) log.warn(`  ${err.message}`);
        if (stateDirty) saveHostBuildState(state);
        return { prebuilt: false, rebuilt: false };
    }

    if (stateDirty) saveHostBuildState(state);
    return { prebuilt: false, rebuilt: false };
}

/**
 * Write a `.build-stamp` file into dist/ with a unique timestamp.
 * This ensures Docker BuildKit's content-based COPY cache always detects
 * a change when the host prebuild actually ran, even if the Vite output
 * is byte-identical (e.g. only whitespace/comment changes).
 */
function writeBuildStamp(distDir: string): void {
    try {
        writeFileSync(
            join(distDir, ".build-stamp"),
            JSON.stringify({ builtAt: new Date().toISOString(), pid: process.pid }) + "\n"
        );
    } catch {
        // Non-fatal — Docker will still detect most changes without it
    }
}

function generateComposeFile(opts: {
    repoPath: string;
    config: WebConfig;
    useDevUi: boolean;
    useLocalUiBuild: boolean;
    imageTag: string;
    prebuiltUi: boolean;
    uiDistHash?: string;
}): string {
    const composePath = join(WEB_DIR, "compose.yml");
    mkdirSync(WEB_DIR, { recursive: true });

    const { repoPath, config, useDevUi, useLocalUiBuild, imageTag, prebuiltUi, uiDistHash } = opts;

    const dataDir = join(WEB_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    let template: string;
    const templatePath = join(import.meta.dirname ?? __dirname, "templates", "compose.yml.template");
    try {
        template = readFileSync(templatePath, "utf-8");
    } catch {
        template = COMPOSE_TEMPLATE;
    }

    const redisPlatformLine = `    platform: ${getDockerPlatform()}\n`;

    const extraOriginsLine = config.extraOrigins
        ? `      - PIZZAPI_EXTRA_ORIGINS=${config.extraOrigins}\n`
        : `      # - PIZZAPI_EXTRA_ORIGINS=\n`;

    // PIZZAPI_TRUST_PROXY: env var overrides config, and gets persisted back.
    // This ensures `PIZZAPI_TRUST_PROXY=true pizza web` is remembered on subsequent runs.
    const envTrustProxy = process.env.PIZZAPI_TRUST_PROXY?.toLowerCase();
    if (envTrustProxy === "true") {
        config.trustProxy = true;
    } else if (envTrustProxy === "false") {
        config.trustProxy = false;
    }

    // PIZZAPI_PROXY_DEPTH: env var overrides config, and gets persisted back.
    const envProxyDepth = process.env.PIZZAPI_PROXY_DEPTH;
    if (envProxyDepth) {
        const parsed = parseInt(envProxyDepth, 10);
        if (!isNaN(parsed) && parsed >= 0) {
            config.proxyDepth = parsed;
        }
    }

    // Persist any env-driven changes back to config.json
    saveWebConfig(config);

    const trustProxyLine = config.trustProxy === true
        ? `      - PIZZAPI_TRUST_PROXY=true\n`
        : config.trustProxy === false
            ? `      - PIZZAPI_TRUST_PROXY=false\n`
            : `      # - PIZZAPI_TRUST_PROXY=\n`;

    const proxyDepthLine = config.proxyDepth !== undefined && config.proxyDepth >= 0
        ? `      - PIZZAPI_PROXY_DEPTH=${config.proxyDepth}\n`
        : `      # - PIZZAPI_PROXY_DEPTH=\n`;

    const prodUiServiceBlock = useLocalUiBuild
        ? ""
        : `  ui:\n    image: ${UI_IMAGE_REPOSITORY}:${imageTag}\n    pull_policy: always\n    command: ["/bin/sh", "-c", "rm -rf /ui-dist/* && cp -a /usr/share/nginx/html/. /ui-dist/ && tail -f /dev/null"]\n    volumes:\n      - ui-dist:/ui-dist\n    healthcheck:\n      test: ["CMD", "test", "-f", "/ui-dist/index.html"]\n      interval: 10s\n      timeout: 5s\n      retries: 5\n    restart: unless-stopped\n\n`;

    const prodUiVolumeLine = useLocalUiBuild ? "" : "      - ui-dist:/app/packages/ui/dist:ro\n";
    const prodUiDependsOnLine = useLocalUiBuild ? "" : "      ui:\n        condition: service_healthy\n";
    const prodServerBuildTarget = useLocalUiBuild ? "runtime" : "runtime-no-ui";

    const devServiceBlock = `  dev:\n    build:\n      context: ${repoPath}\n      dockerfile: Dockerfile\n      target: builder\n    command: bun run dev\n    ports:\n      - "${config.port}:7492"\n      - "5173:5173"\n    environment:\n      - PORT=7492\n      - PIZZAPI_REDIS_URL=redis://redis:6379\n      - BETTER_AUTH_SECRET=${config.betterAuthSecret}\n      - AUTH_DB_PATH=/app/data/auth.db\n      - VAPID_PUBLIC_KEY=${config.vapid.publicKey}\n      - VAPID_PRIVATE_KEY=${config.vapid.privateKey}\n      - VAPID_SUBJECT=${config.vapidSubject}\n${extraOriginsLine}${trustProxyLine}${proxyDepthLine}    volumes:\n      - ${repoPath}:/app:Z\n      - /app/node_modules\n      - ${dataDir}:/app/data:Z\n    depends_on:\n      redis:\n        condition: service_healthy\n    restart: unless-stopped\n    stop_grace_period: 30s\n\n`;

    const appServiceBlock = useDevUi
        ? devServiceBlock
        : `${prodUiServiceBlock}  server:\n    build:\n      context: ${repoPath}\n      dockerfile: Dockerfile\n      target: ${prodServerBuildTarget}\n      args:\n        PREBUILT_UI: "${prebuiltUi ? "true" : "false"}"\n        UI_DIST_HASH: "${uiDistHash ?? "none"}"\n    ports:\n      - "${config.port}:7492"\n    environment:\n      - PORT=7492\n      - PIZZAPI_REDIS_URL=redis://redis:6379\n      - BETTER_AUTH_SECRET=${config.betterAuthSecret}\n      - VAPID_PUBLIC_KEY=${config.vapid.publicKey}\n      - VAPID_PRIVATE_KEY=${config.vapid.privateKey}\n      - VAPID_SUBJECT=${config.vapidSubject}\n${extraOriginsLine}${trustProxyLine}${proxyDepthLine}    volumes:\n      - ${dataDir}:/app/data:Z\n${prodUiVolumeLine}    depends_on:\n      redis:\n        condition: service_started\n${prodUiDependsOnLine}    restart: unless-stopped\n    stop_grace_period: 30s\n\n`;
    const volumesSection = useDevUi ? "" : "volumes:\n  ui-dist:\n";

    const compose = template
        .replace(/\{\{REDIS_PLATFORM_LINE}}/g, redisPlatformLine)
        .replace(/\{\{APP_SERVICE_BLOCK}}/g, appServiceBlock)
        .replace(/\{\{VOLUMES_SECTION}}/g, volumesSection);

    // Only write if changed
    const existing = existsSync(composePath) ? readFileSync(composePath, "utf-8") : null;
    if (existing === compose) {
        log.info(`Config unchanged: ${composePath}`);
    } else {
        writeFileSync(composePath, compose);
        log.info(existing ? `Updated ${composePath}` : `Created ${composePath}`);
    }

    return composePath;
}

// ─── Compose execution ────────────────────────────────────────────────────────

async function composeExecAsync(composePath: string, args: string[]): Promise<number> {
    return new Promise<number>((resolve) => {
        // If compose.override.yml exists next to the generated compose.yml,
        // include it so Docker Compose merges it. Passing an explicit -f flag
        // disables automatic override detection, so we must add it manually.
        const overridePath = join(dirname(composePath), "compose.override.yml");
        const composeFileArgs: string[] = ["-f", composePath];
        if (existsSync(overridePath)) {
            composeFileArgs.push("-f", overridePath);
        }
        const child = spawn(
            "docker",
            ["compose", ...composeFileArgs, "-p", "pizzapi-web", ...args],
            { stdio: "inherit" }
        );
        const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
        const handler = (sig: NodeJS.Signals) => child.kill(sig);
        signals.forEach((sig) => process.on(sig, handler));
        child.on("close", (code) => {
            signals.forEach((sig) => process.removeListener(sig, handler));
            resolve(code ?? 1);
        });
    });
}

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
    port?: number;
    origins?: string;
    tag: string;
    build: boolean;
    devUi: boolean;
    detach: boolean;
    noCache: boolean;
    help: boolean;
}

function isValidDockerTag(tag: string): boolean {
    // Docker tags are 1–128 chars; allow common tag characters.
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag);
}

/** Read the CLI version from package.json (used as default Docker image tag). */
export function getCliVersion(): string {
    try {
        const require = createRequire(import.meta.url);
        const pkg = require("../package.json");
        return typeof pkg?.version === "string" ? pkg.version : "latest";
    } catch {
        return "latest";
    }
}

export function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = { tag: "latest", build: false, devUi: false, detach: true, noCache: false, help: false };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--port" && args[i + 1]) {
            if (!/^\d+$/.test(args[i + 1])) {
                log.error("Invalid port number");
                process.exit(1);
            }
            const p = parseInt(args[i + 1], 10);
            if (p < 1 || p > 65535) {
                log.error("Invalid port number");
                process.exit(1);
            }
            result.port = p;
            i++;
        } else if (arg === "--origins") {
            const next = args[i + 1];
            if (!next || next.startsWith("-")) {
                log.error("--origins requires a value (comma-separated origin URLs)");
                process.exit(1);
            }
            result.origins = next;
            i++;
        } else if (arg === "--tag") {
            const next = args[i + 1];
            if (!next || next.startsWith("-")) {
                log.error("--tag requires a value (for example: latest, main, sha)");
                process.exit(1);
            }
            if (!isValidDockerTag(next)) {
                log.error(`Invalid image tag: ${next}`);
                process.exit(1);
            }
            result.tag = next;
            i++;
        } else if (arg === "--build") {
            result.build = true;
        } else if (arg === "--dev-ui") {
            result.devUi = true;
        } else if (arg === "--foreground" || arg === "-f") {
            result.detach = false;
        } else if (arg === "--no-cache") {
            result.noCache = true;
        } else if (arg === "--help" || arg === "-h") {
            result.help = true;
        }
    }

    return result;
}

// ─── Help text ────────────────────────────────────────────────────────────────

function printWebHelp(): void {
    log.info("");
    log.info(`${c.brand("pizza web")} ${c.dim("— Manage the PizzaPi web hub (server + UI via Docker Compose)")}`);
    log.info("");
    log.info(c.label("Commands"));
    log.info(`  ${c.cmd("pizza web")} ${c.dim("[flags]")}               Start the web hub`);
    log.info(`  ${c.cmd("pizza web stop")}                  Stop the web hub`);
    log.info(`  ${c.cmd("pizza web logs")}                  Tail container logs`);
    log.info(`  ${c.cmd("pizza web status")}                Show container status`);
    log.info(`  ${c.cmd("pizza web config")}                Show current configuration`);
    log.info(`  ${c.cmd("pizza web config set")} ${c.dim("<k> <v>")}    Update a config value`);
    log.info("");
    log.info(c.label("Flags"));
    log.info(`  ${c.flag("--port")} ${c.dim("<port>")}       Set the host port ${c.dim("(persisted to config.json)")}`);
    log.info(`  ${c.flag("--origins")} ${c.dim("<list>")}    Set extra allowed CORS origins ${c.dim("(comma-separated, persisted)")}`);
    log.info(`  ${c.flag("--tag")} ${c.dim("<tag>")}         UI image tag from GHCR ${c.dim("(default: CLI version, or latest)")}`);
    log.info(`  ${c.flag("--build")}             Build UI locally ${c.dim("(fallback mode)")}`);
    log.info(`  ${c.flag("--dev-ui")}           Use the local dev UI ${c.dim("(local repo only)")}`);
    log.info(`  ${c.flag("-f, --foreground")}    Run in the foreground ${c.dim("(don't detach)")}`);
    log.info(`  ${c.flag("--no-cache")}          Rebuild Docker image without layer cache`);
    log.info(`  ${c.flag("-h, --help")}          Show this help`);
    log.info("");
    log.info(`${c.label("Configuration")} ${c.dim(`(${CONFIG_PATH})`)}`);
    log.info(`  ${c.accent("port")}            Host port ${c.dim("(default: 7492)")}`);
    log.info(`  ${c.accent("vapidSubject")}    VAPID subject for push notifications`);
    log.info(`  ${c.accent("extraOrigins")}    Extra CORS origins, comma-separated`);
    log.info("");
    log.info(c.label("Examples"));
    log.info(`  ${c.dim("pizza web")}                           Start on default port 7492`);
    log.info(`  ${c.dim("pizza web --tag main")}                 Pull ghcr.io/pizzaface/pizzapi-ui:main`);
    log.info(`  ${c.dim("pizza web --build")}                    Build UI locally (fallback mode)`);
    log.info(`  ${c.dim("pizza web --dev-ui")}                   Use local dev UI (local repo only)`);
    log.info(`  ${c.dim("pizza web --port 8080")}               Start on port 8080 (remembered for next time)`);
    log.info(`  ${c.dim("pizza web config set port 9000")}      Change port without starting`);
    log.info(`  ${c.dim('pizza web config set extraOrigins "https://example.com"')}`);
    log.info("");
}

// ─── Config subcommand ────────────────────────────────────────────────────────

const SETTABLE_KEYS = ["port", "vapidSubject", "extraOrigins"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

function runConfigSubcommand(args: string[]): void {
    // Handle help before loading config (no side effects)
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
        log.info(`
pizza web config — View or update web hub configuration

Usage:
  pizza web config                    Show current config
  pizza web config set <key> <value>  Update a config value

Settable keys:
  port            Host port (number)
  vapidSubject    VAPID subject for push notifications
  extraOrigins    Extra CORS origins, comma-separated
`.trim());
        return;
    }

    const config = loadWebConfig();

    // pizza web config (show)
    if (args.length === 0) {
        log.info(`PizzaPi Web Config (${CONFIG_PATH}):\n`);
        log.info(`  port:          ${config.port}`);
        log.info(`  vapidSubject:  ${config.vapidSubject}`);
        log.info(`  extraOrigins:  ${config.extraOrigins || "(none)"}`);
        log.info(`  authSecret:    ${config.betterAuthSecret ? "*".repeat(20) + "..." : "(missing)"}`);
        log.info(`  vapid.public:  ${config.vapid.publicKey.slice(0, 20)}...`);
        log.info(`  vapid.private: ${"*".repeat(20)}...`);
        return;
    }

    // pizza web config set <key> <value>
    if (args[0] === "set") {
        const key = args[1] as SettableKey;

        if (!key || args.length < 3) {
            log.error("Usage: pizza web config set <key> <value>");
            log.error(`Settable keys: ${SETTABLE_KEYS.join(", ")}`);
            process.exit(1);
        }

        if (!SETTABLE_KEYS.includes(key)) {
            log.error(`Unknown config key: ${key}`);
            log.error(`Settable keys: ${SETTABLE_KEYS.join(", ")}`);
            process.exit(1);
        }

        const value = args.slice(2).join(" ");

        if (key === "port") {
            if (!/^\d+$/.test(value)) {
                log.error("Invalid port number");
                process.exit(1);
            }
            const p = parseInt(value, 10);
            if (p < 1 || p > 65535) {
                log.error("Invalid port number");
                process.exit(1);
            }
            config.port = p;
        } else if (key === "vapidSubject") {
            if (!value) {
                log.error("vapidSubject cannot be empty (required for push notifications)");
                process.exit(1);
            }
            config.vapidSubject = value;
        } else {
            // extraOrigins: empty string is valid (clears the setting)
            config[key] = value;
        }

        saveWebConfig(config);
        log.info(`Set ${key} = ${value}`);
        log.info("Run `pizza web` to apply changes.");
        return;
    }

    log.error(`Unknown config subcommand: ${args[0]}`);
    log.error("Run `pizza web config --help` for usage.");
    process.exit(1);
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runWeb(args: string[]): Promise<void> {
    const subcommand = args[0];

    // pizza web --help / pizza web -h
    if (subcommand === "--help" || subcommand === "-h") {
        printWebHelp();
        return;
    }

    // pizza web stop
    if (subcommand === "stop") {
        ensureDocker();
        const composePath = join(WEB_DIR, "compose.yml");
        if (!existsSync(composePath)) {
            log.info("PizzaPi web is not running.");
            return;
        }
        log.info("Stopping PizzaPi web...");
        await composeExecAsync(composePath, ["down"]);
        return;
    }

    // pizza web logs
    if (subcommand === "logs") {
        ensureDocker();
        const composePath = join(WEB_DIR, "compose.yml");
        if (!existsSync(composePath)) {
            log.info("PizzaPi web is not running.");
            return;
        }
        await composeExecAsync(composePath, ["logs", "-f", "--tail", "100"]);
        return;
    }

    // pizza web status
    if (subcommand === "status") {
        ensureDocker();
        const composePath = join(WEB_DIR, "compose.yml");
        if (!existsSync(composePath)) {
            log.info("PizzaPi web is not set up. Run `pizza web` to start.");
            return;
        }
        await composeExecAsync(composePath, ["ps"]);
        return;
    }

    // pizza web config [...]
    if (subcommand === "config") {
        runConfigSubcommand(args.slice(1));
        return;
    }

    // pizza web (start)
    const parsed = parseArgs(args);

    if (parsed.help) {
        printWebHelp();
        return;
    }

    ensureDocker();

    // Load config and apply any CLI overrides (persisted)
    const config = loadWebConfig();
    let configChanged = false;

    if (parsed.port !== undefined && parsed.port !== config.port) {
        config.port = parsed.port;
        configChanged = true;
    }
    if (parsed.origins !== undefined && parsed.origins !== config.extraOrigins) {
        config.extraOrigins = parsed.origins;
        configChanged = true;
    }
    if (configChanged) {
        saveWebConfig(config);
    }

    const repoRoot = findRepoRoot();
    const isLocalRepo = repoRoot !== null;
    const repoPath = isLocalRepo ? repoRoot : getRepoPath();

    // When running from a cloned/remote repo, default the image tag to the
    // CLI version so the Docker image matches the installed CLI release.
    if (!parsed.build && !parsed.devUi && !isLocalRepo && parsed.tag === "latest") {
        const cliVersion = getCliVersion();
        if (cliVersion !== "latest") {
            parsed.tag = cliVersion;
            log.info(`Using Docker image tag matching CLI version: ${cliVersion}`);
        }
    }

    const useDevUi = parsed.devUi;
    if (useDevUi && !isLocalRepo) {
        log.error("--dev-ui requires a local PizzaPi checkout.");
        process.exit(1);
    }
    const useLocalUiBuild = parsed.build;

    let prebuildResult: PrebuildResult = { prebuilt: false, rebuilt: false };
    if (useLocalUiBuild) {
        const useHostPrebuild = readBooleanEnv(process.env.PIZZAPI_PREBUILD_UI, true);
        if (!useHostPrebuild) {
            log.info("Skipping host UI pre-build (PIZZAPI_PREBUILD_UI=false).");
        }

        // Local fallback mode: pre-build UI on the host for much faster Docker builds when enabled.
        prebuildResult = useHostPrebuild
            ? prebuildUI(repoPath)
            : { prebuilt: false, rebuilt: false };
    }

    const composePath = generateComposeFile({
        repoPath,
        config,
        useDevUi,
        useLocalUiBuild,
        imageTag: parsed.tag,
        prebuiltUi: prebuildResult.prebuilt,
        uiDistHash: prebuildResult.distHash,
    });

    log.info(`Starting PizzaPi web on port ${config.port}...`);
    log.info(`  Repo:    ${repoPath}`);
    log.info(`  Config:  ${CONFIG_PATH}`);
    if (useDevUi) {
        log.info("  UI:      http://localhost:5173 (dev:ui)");
    } else if (useLocalUiBuild) {
        log.info("  UI:      local build (--build)");
    } else {
        log.info(`  UI:      ${UI_IMAGE_REPOSITORY}:${parsed.tag}`);
    }
    log.info("");

    if (!useDevUi && !parsed.build) {
        log.info(`Pulling UI image ${UI_IMAGE_REPOSITORY}:${parsed.tag}...`);
        await composeExecAsync(composePath, ["pull", "ui"]);
    }

    // When the host prebuild actually rebuilt, force-recreate containers so
    // Docker picks up the new image even if BuildKit's layer cache didn't
    // detect the change (common on macOS Docker Desktop with virtiofs).
    const forceRecreate = (useLocalUiBuild && prebuildResult.rebuilt) || parsed.noCache;

    // --no-cache: run a separate `docker compose build --no-cache` first,
    // because `docker compose up` doesn't support --no-cache directly.
    if (parsed.noCache) {
        log.info("Building without cache...");
        await composeExecAsync(composePath, ["build", "--no-cache"]);
    }

    if (parsed.detach) {
        const upArgs = ["up", "-d", "--build"];
        if (forceRecreate) upArgs.push("--force-recreate");
        await composeExecAsync(composePath, upArgs);
        log.info("");
        log.info(`✅ PizzaPi web is running at http://localhost:${config.port}`);
        if (useDevUi) {
            log.info("   UI dev server at http://localhost:5173");
        }
        log.info("");
        log.info("  pizza web logs      View logs");
        log.info("  pizza web status    Check status");
        log.info("  pizza web stop      Stop the hub");
        log.info("  pizza web config    View configuration");
    } else {
        const upArgs = ["up", "--build"];
        if (forceRecreate) upArgs.push("--force-recreate");
        await composeExecAsync(composePath, upArgs);
    }
}
