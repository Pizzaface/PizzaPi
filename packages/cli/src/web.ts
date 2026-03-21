/**
 * `pizza web` — Start the PizzaPi web hub (server + UI) using Docker Compose.
 *
 * Usage:
 *   pizza web                  Start the hub (default port 7492)
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
import { join } from "path";
import { homedir } from "os";
import { c } from "./cli-colors.js";
import { createLogger } from "@pizzapi/tools";

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
    /** Optional Docker image repository for the server (e.g. ghcr.io/org/pizzapi). */
    image: string;
    /** Docker image tag to deploy when image mode is enabled. */
    imageTag: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEB_DIR = join(homedir(), ".pizzapi", "web");
const CONFIG_PATH = join(WEB_DIR, "config.json");
const HOST_BUILD_STATE_PATH = join(WEB_DIR, "host-build.json");
const REPO_URL = "https://github.com/Pizzaface/PizzaPi.git";
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
    image: "",
    imageTag: "latest",
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

// ─── Compose template ─────────────────────────────────────────────────────────

// Inline the compose template so it works inside compiled Bun binaries
// where /$bunfs/root/ has no access to external files.
const COMPOSE_TEMPLATE = `# Auto-generated by \`pizza web\` — regenerated on each run.
# For custom overrides, create a compose.override.yml next to this file.
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    restart: unless-stopped

  server:
{{SERVER_BUILD_BLOCK}}      args:
        PREBUILT_UI: "{{PREBUILT_UI}}"
{{SERVER_IMAGE_LINE}}    ports:
      - "{{PORT}}:7492"
    environment:
      - PORT=7492
      - PIZZAPI_REDIS_URL=redis://redis:6379
      - PIZZAPI_HUB_IMAGE={{HUB_IMAGE}}
      - PIZZAPI_HUB_VERSION={{HUB_VERSION}}
      - BETTER_AUTH_SECRET={{BETTER_AUTH_SECRET}}
      - VAPID_PUBLIC_KEY={{VAPID_PUBLIC_KEY}}
      - VAPID_PRIVATE_KEY={{VAPID_PRIVATE_KEY}}
      - VAPID_SUBJECT={{VAPID_SUBJECT}}
{{EXTRA_ORIGINS_LINE}}{{TRUST_PROXY_LINE}}{{PROXY_DEPTH_LINE}}    volumes:
      - {{DATA_DIR}}:/app/data:Z
    depends_on:
      - redis
    restart: unless-stopped
    stop_grace_period: 30s
`;

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
 * Truncate a digest string (e.g. "sha256:abcdef0123456789...") to show the
 * algorithm prefix plus 12 hex characters.  This preserves enough information
 * to reliably identify a specific image while keeping the display compact.
 */
function truncateDigest(digest: string | undefined): string {
    if (!digest) return "digest";
    const colonIdx = digest.indexOf(":");
    if (colonIdx === -1) return digest.slice(0, 19) || "digest";
    // Keep the algorithm prefix (e.g. "sha256:") plus 12 hex characters
    const prefix = digest.slice(0, colonIdx + 1);
    const hex = digest.slice(colonIdx + 1, colonIdx + 1 + 12);
    return hex.length > 0 ? `${prefix}${hex}` : "digest";
}

export function normalizeImageRepoForExplicitTag(imageRepo: string): string {
    if (imageRepo.includes("@")) return imageRepo;
    const lastSlash = imageRepo.lastIndexOf("/");
    const afterSlash = lastSlash === -1 ? imageRepo : imageRepo.slice(lastSlash + 1);
    const colonInLastPart = afterSlash.indexOf(":");
    if (colonInLastPart === -1) return imageRepo;
    return imageRepo.slice(0, imageRepo.lastIndexOf(":"));
}

export function resolveComposeMode(repoPath: string, config: Pick<WebConfig, "image" | "imageTag">): {
    buildBlock: string;
    imageLine: string;
    hubImage: string;
    hubVersion: string;
} {
    const imageRepo = config.image.trim();
    if (imageRepo.length === 0) {
        return {
            buildBlock: `    build:
      context: ${repoPath}
      dockerfile: Dockerfile
`,
            imageLine: "",
            hubImage: "local-build",
            hubVersion: "local",
        };
    }

    // If the image reference already contains a digest (@sha256:...), use it as-is
    // — appending a tag to a digest reference produces an invalid image ref.
    const hasDigest = imageRepo.includes("@");

    // If the image reference already contains a tag (e.g. "ghcr.io/acme/pizzapi:0.1.32"),
    // use it as-is — appending another ":tag" would produce an invalid image ref.
    // A tag is present when the portion after the last "/" contains a ":".
    const lastSlash = imageRepo.lastIndexOf("/");
    const afterSlash = lastSlash === -1 ? imageRepo : imageRepo.slice(lastSlash + 1);
    const colonInLastPart = afterSlash.indexOf(":");
    const hasEmbeddedTag = !hasDigest && colonInLastPart !== -1;

    let imageRef: string;
    let resolvedTag: string;
    if (hasDigest) {
        imageRef = imageRepo;
        resolvedTag = "digest";
    } else if (hasEmbeddedTag) {
        const embeddedTag = afterSlash.slice(colonInLastPart + 1);
        const explicitTag = config.imageTag.trim();
        // Honor an explicit, non-default imageTag override: if the operator
        // ran `pizza web --tag X` or `pizza web config set imageTag X` with a
        // tag that differs from what is baked into the image ref, strip the
        // embedded tag and use the explicit one.  We skip this when
        // explicitTag is "latest" because that is the default value and cannot
        // be distinguished from "the operator never touched imageTag" — in that
        // case we preserve the embedded tag as the operator originally intended.
        if (explicitTag && explicitTag !== "latest" && explicitTag !== embeddedTag) {
            const repoBase = imageRepo.slice(0, imageRepo.lastIndexOf(":"));
            resolvedTag = explicitTag;
            imageRef = `${repoBase}:${resolvedTag}`;
        } else {
            // Tag already baked in — use as-is
            imageRef = imageRepo;
            resolvedTag = embeddedTag;
        }
    } else {
        resolvedTag = config.imageTag.trim() || "latest";
        imageRef = `${imageRepo}:${resolvedTag}`;
    }

    // Use `pull_policy: always` for mutable tags (latest, main, stable, …) so
    // operators automatically receive new images on restart.  An embedded tag
    // that resolves to a mutable name should also get `always` — the tag is
    // already baked into the image reference, but the tag still tracks a moving
    // pointer and needs to be re-pulled.  Digest-pinned references and semver
    // tags default to `if_not_present` so restarts succeed even when the
    // registry is unreachable.
    const mutableTags = new Set(["latest", "main", "stable", "dev", "nightly"]);
    const pullPolicy = !hasDigest && mutableTags.has(resolvedTag) ? "always" : "if_not_present";

    return {
        buildBlock: "",
        imageLine: `    image: ${imageRef}
    pull_policy: ${pullPolicy}
`,
        hubImage: imageRef,
        hubVersion: hasDigest ? truncateDigest(imageRepo.split("@")[1]) : resolvedTag,
    };
}

function generateComposeFile(repoPath: string, config: WebConfig, prebuiltUi: boolean): string {
    const composePath = join(WEB_DIR, "compose.yml");
    mkdirSync(WEB_DIR, { recursive: true });

    const dataDir = join(WEB_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    let template: string;
    const templatePath = join(import.meta.dirname ?? __dirname, "templates", "compose.yml.template");
    try {
        template = readFileSync(templatePath, "utf-8");
    } catch {
        template = COMPOSE_TEMPLATE;
    }

    const composeMode = resolveComposeMode(repoPath, config);

    const extraOriginsLine = config.extraOrigins
        ? `      - PIZZAPI_EXTRA_ORIGINS=${config.extraOrigins}
`
        : `      # - PIZZAPI_EXTRA_ORIGINS=
`;

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

    const compose = template
        .replace(/\{\{REPO_PATH}}/g, repoPath)
        .replace(/\{\{SERVER_BUILD_BLOCK}}/g, composeMode.buildBlock)
        .replace(/\{\{SERVER_IMAGE_LINE}}/g, composeMode.imageLine)
        .replace(/\{\{HUB_IMAGE}}/g, composeMode.hubImage)
        .replace(/\{\{HUB_VERSION}}/g, composeMode.hubVersion)
        .replace(/\{\{PORT}}/g, String(config.port))
        .replace(/\{\{DATA_DIR}}/g, dataDir)
        .replace(/\{\{VAPID_PUBLIC_KEY}}/g, config.vapid.publicKey)
        .replace(/\{\{VAPID_PRIVATE_KEY}}/g, config.vapid.privateKey)
        .replace(/\{\{VAPID_SUBJECT}}/g, config.vapidSubject)
        .replace(/\{\{BETTER_AUTH_SECRET}}/g, config.betterAuthSecret)
        .replace(/\{\{EXTRA_ORIGINS_LINE}}/g, extraOriginsLine)
        .replace(/\{\{TRUST_PROXY_LINE}}/g, trustProxyLine)
        .replace(/\{\{PROXY_DEPTH_LINE}}/g, proxyDepthLine)
        .replace(/\{\{PREBUILT_UI}}/g, prebuiltUi ? "true" : "false")
        .replace(/\{\{UI_DIST_HASH}}/g, uiDistHash ?? "none");

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
        const child = spawn(
            "docker",
            ["compose", "-f", composePath, "-p", "pizzapi-web", ...args],
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
    image?: string;
    tag?: string;
    detach: boolean;
    noCache: boolean;
    help: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = { detach: true, noCache: false, help: false };

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
        } else if (arg === "--image") {
            const next = args[i + 1];
            if (!next || next.startsWith("-")) {
                console.error("--image requires a value (e.g. ghcr.io/org/pizzapi)");
                process.exit(1);
            }
            result.image = next;
            i++;
        } else if (arg === "--tag") {
            const next = args[i + 1];
            if (!next || next.startsWith("-")) {
                console.error("--tag requires a value (e.g. latest or 0.1.32)");
                process.exit(1);
            }
            result.tag = next;
            i++;
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
    console.log(`
pizza web — Manage the PizzaPi web hub (server + UI via Docker Compose)

Usage:
  pizza web [flags]               Start the web hub
  pizza web stop                  Stop the web hub
  pizza web logs                  Tail container logs
  pizza web status                Show container status
  pizza web config                Show current configuration
  pizza web config set <k> <v>    Update a config value

Flags:
  --port <port>       Set the host port (persisted to config.json)
  --origins <list>    Set extra allowed CORS origins (comma-separated, persisted)
  --image <repo>      Use a prebuilt Docker image repo (e.g. ghcr.io/org/pizzapi)
  --tag <tag>         Image tag when --image is set (default: latest)
  -f, --foreground    Run in the foreground (don't detach)
  -h, --help          Show this help

Configuration (${CONFIG_PATH}):
  port            Host port (default: 7492)
  vapidSubject    VAPID subject for push notifications (default: mailto:admin@pizzapi.local)
  extraOrigins    Extra CORS origins, comma-separated
  image           Optional Docker image repo (empty = build from source)
  imageTag        Docker image tag for image mode (default: latest)

Examples:
  pizza web                           Start on default port 7492
  pizza web --port 8080               Start on port 8080 (remembered for next time)
  pizza web --image ghcr.io/acme/pizzapi --tag 0.1.32
  pizza web config set port 9000      Change port without starting
  pizza web config set extraOrigins "https://example.com"
`.trim());
}

// ─── Config subcommand ────────────────────────────────────────────────────────

const SETTABLE_KEYS = ["port", "vapidSubject", "extraOrigins", "image", "imageTag"] as const;
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
  image           Docker image repo (empty = build from source)
  imageTag        Docker image tag for image mode
`.trim());
        return;
    }

    const config = loadWebConfig();

    // pizza web config (show)
    if (args.length === 0) {
        console.log(`PizzaPi Web Config (${CONFIG_PATH}):\n`);
        console.log(`  port:          ${config.port}`);
        console.log(`  vapidSubject:  ${config.vapidSubject}`);
        console.log(`  extraOrigins:  ${config.extraOrigins || "(none)"}`);
        console.log(`  image:         ${config.image || "(build from source)"}`);
        console.log(`  imageTag:      ${config.imageTag}`);
        console.log(`  authSecret:    ${config.betterAuthSecret ? "*".repeat(20) + "..." : "(missing)"}`);
        console.log(`  vapid.public:  ${config.vapid.publicKey.slice(0, 20)}...`);
        console.log(`  vapid.private: ${"*".repeat(20)}...`);
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
        } else if (key === "image") {
            const newImage = value.trim();
            if (newImage !== config.image) {
                config.image = newImage;
            }
            // Reapplying an image (even the same repo) should clear a pinned
            // tag so the documented default delivery tag (latest) takes effect.
            if (config.imageTag !== "latest") {
                config.imageTag = "latest";
            }
        } else if (key === "imageTag") {
            if (!value.trim()) {
                console.error("imageTag cannot be empty");
                process.exit(1);
            }
            config.imageTag = value.trim();
            config.image = normalizeImageRepoForExplicitTag(config.image);
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
    const shouldResetImageTag = parsed.image !== undefined && parsed.tag === undefined;
    if (parsed.image !== undefined) {
        const newImage = parsed.image.trim();
        if (newImage !== config.image) {
            config.image = newImage;
            configChanged = true;
        }
    }
    if (shouldResetImageTag && config.imageTag !== "latest") {
        // Reapply the default tag even when the repo was already set so
        // `pizza web --image ...` without --tag unpins a previous version.
        config.imageTag = "latest";
        configChanged = true;
    }
    if (parsed.tag !== undefined) {
        const normalizedImage = normalizeImageRepoForExplicitTag(config.image);
        if (normalizedImage !== config.image) {
            config.image = normalizedImage;
            configChanged = true;
        }
        if (parsed.tag !== config.imageTag) {
            config.imageTag = parsed.tag;
            configChanged = true;
        }
    }
    if (configChanged) {
        saveWebConfig(config);
    }

    const useImageMode = config.image.trim().length > 0;
    const repoPath = useImageMode ? "" : getRepoPath();

    let prebuiltUi = false;
    if (!useImageMode) {
        const useHostPrebuild = readBooleanEnv(process.env.PIZZAPI_PREBUILD_UI, true);
        if (!useHostPrebuild) {
            console.log("Skipping host UI pre-build (PIZZAPI_PREBUILD_UI=false).");
        }
        // Pre-build UI on the host for much faster Docker builds when enabled.
        prebuiltUi = useHostPrebuild ? prebuildUI(repoPath) : false;
    }
    const composePath = generateComposeFile(repoPath, config, prebuiltUi);

    console.log(`Starting PizzaPi web on port ${config.port}...`);
    if (useImageMode) {
        console.log(`  Image:   ${config.image}:${config.imageTag}`);
    } else {
        console.log(`  Repo:    ${repoPath}`);
    }
    console.log(`  Config:  ${CONFIG_PATH}`);
    console.log();

    if (parsed.detach) {
        const upArgs = ["up", "-d", "--build"];
        await composeExecAsync(composePath, upArgs);
        log.info("");
        log.info(`✅ PizzaPi web is running at http://localhost:${config.port}`);
        log.info("");
        log.info("  pizza web logs      View logs");
        log.info("  pizza web status    Check status");
        log.info("  pizza web stop      Stop the hub");
        log.info("  pizza web config    View configuration");
    } else {
        const upArgs = ["up", "--build"];
        await composeExecAsync(composePath, upArgs);
    }
}
