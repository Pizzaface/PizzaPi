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

import { execSync, spawn } from "child_process";
import { createECDH } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEB_DIR = join(homedir(), ".pizzapi", "web");
const CONFIG_PATH = join(WEB_DIR, "config.json");
const REPO_URL = "https://github.com/Pizzaface/PizzaPi.git";

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

// ─── Config management ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WebConfig = {
    port: 7492,
    vapid: { publicKey: "", privateKey: "" },
    vapidSubject: "mailto:admin@pizzapi.local",
    extraOrigins: "",
};

/** Extract VAPID keys from compose.yml content (pure function, exported for testing) */
export function extractVapidFromCompose(content: string): { publicKey: string; privateKey: string } | null {
    const pubMatch = content.match(/VAPID_PUBLIC_KEY=(.+)/);
    const privMatch = content.match(/VAPID_PRIVATE_KEY=(.+)/);
    if (pubMatch?.[1] && privMatch?.[1]) {
        const keys = {
            publicKey: pubMatch[1].trim(),
            privateKey: privMatch[1].trim(),
        };
        // Skip template placeholders
        if (keys.publicKey.startsWith("{{")) return null;
        return keys;
    }
    return null;
}

/** Migrate VAPID keys from legacy vapid.json or existing compose.yml */
function migrateLegacyVapid(): { publicKey: string; privateKey: string } | null {
    // 1. Check for vapid.json (from previous version of this code)
    const vapidJsonPath = join(WEB_DIR, "vapid.json");
    if (existsSync(vapidJsonPath)) {
        try {
            const stored = JSON.parse(readFileSync(vapidJsonPath, "utf-8"));
            if (stored.publicKey && stored.privateKey) {
                console.log("Migrated VAPID keys from vapid.json → config.json");
                return stored;
            }
        } catch { /* corrupted */ }
    }

    // 2. Extract from existing compose.yml
    const composePath = join(WEB_DIR, "compose.yml");
    if (existsSync(composePath)) {
        try {
            const keys = extractVapidFromCompose(readFileSync(composePath, "utf-8"));
            if (keys) {
                console.log("Migrated VAPID keys from compose.yml → config.json");
                return keys;
            }
        } catch { /* can't read */ }
    }

    return null;
}

/** Load config from disk, migrating from legacy formats if needed */
export function loadWebConfig(): WebConfig {
    mkdirSync(WEB_DIR, { recursive: true });

    if (existsSync(CONFIG_PATH)) {
        try {
            const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
            // Merge with defaults so new fields get default values
            return { ...DEFAULT_CONFIG, ...stored };
        } catch {
            console.warn("Warning: config.json is corrupted, using defaults.");
        }
    }

    // First run or corrupted — build config from legacy sources
    const config: WebConfig = { ...DEFAULT_CONFIG };

    const legacyVapid = migrateLegacyVapid();
    if (legacyVapid) {
        config.vapid = legacyVapid;
    } else {
        config.vapid = generateVapidKeys();
        console.log("Generated new VAPID keys for push notifications.");
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
        execSync("docker --version", { stdio: "ignore" });
        execSync("docker compose version", { stdio: "ignore" });
    } catch {
        console.error(
            "Error: Docker with Compose is required for `pizza web`.\n" +
            "Install Docker Desktop: https://docs.docker.com/get-docker/\n"
        );
        process.exit(1);
    }
}

// ─── Repo discovery ───────────────────────────────────────────────────────────

function findRepoRoot(): string | null {
    let dir = import.meta.dirname ?? __dirname;
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
    return null;
}

function getRepoPath(): string {
    const repoRoot = findRepoRoot();
    if (repoRoot) return repoRoot;

    const clonedRepo = join(WEB_DIR, "repo");
    if (existsSync(join(clonedRepo, "Dockerfile"))) {
        console.log("Updating PizzaPi repository...");
        try {
            execSync("git pull --rebase", { cwd: clonedRepo, stdio: "inherit" });
        } catch {
            console.warn("Warning: Could not update repo, using existing version.");
        }
        return clonedRepo;
    }

    console.log("Cloning PizzaPi repository...");
    mkdirSync(WEB_DIR, { recursive: true });
    try {
        execSync(`git clone --depth 1 ${REPO_URL} ${clonedRepo}`, { stdio: "inherit" });
    } catch {
        console.error(
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
    build:
      context: {{REPO_PATH}}
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:7492"
    environment:
      - PORT=7492
      - PIZZAPI_REDIS_URL=redis://redis:6379
      - VAPID_PUBLIC_KEY={{VAPID_PUBLIC_KEY}}
      - VAPID_PRIVATE_KEY={{VAPID_PRIVATE_KEY}}
      - VAPID_SUBJECT={{VAPID_SUBJECT}}
{{EXTRA_ORIGINS_LINE}}    volumes:
      - {{DATA_DIR}}:/app/data
    depends_on:
      - redis
    restart: unless-stopped
`;

function generateComposeFile(repoPath: string, config: WebConfig): string {
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

    const extraOriginsLine = config.extraOrigins
        ? `      - PIZZAPI_EXTRA_ORIGINS=${config.extraOrigins}\n`
        : `      # - PIZZAPI_EXTRA_ORIGINS=\n`;

    const compose = template
        .replace(/\{\{REPO_PATH}}/g, repoPath)
        .replace(/\{\{PORT}}/g, String(config.port))
        .replace(/\{\{DATA_DIR}}/g, dataDir)
        .replace(/\{\{VAPID_PUBLIC_KEY}}/g, config.vapid.publicKey)
        .replace(/\{\{VAPID_PRIVATE_KEY}}/g, config.vapid.privateKey)
        .replace(/\{\{VAPID_SUBJECT}}/g, config.vapidSubject)
        .replace(/\{\{EXTRA_ORIGINS_LINE}}/g, extraOriginsLine);

    // Only write if changed
    const existing = existsSync(composePath) ? readFileSync(composePath, "utf-8") : null;
    if (existing === compose) {
        console.log(`Config unchanged: ${composePath}`);
    } else {
        writeFileSync(composePath, compose);
        console.log(existing ? `Updated ${composePath}` : `Created ${composePath}`);
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
    detach: boolean;
    help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
    const result: ParsedArgs = { detach: true, help: false };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--port" && args[i + 1]) {
            const p = parseInt(args[i + 1], 10);
            if (isNaN(p) || p < 1 || p > 65535) {
                console.error("Invalid port number");
                process.exit(1);
            }
            result.port = p;
            i++;
        } else if (arg === "--origins" && args[i + 1]) {
            result.origins = args[i + 1];
            i++;
        } else if (arg === "--foreground" || arg === "-f") {
            result.detach = false;
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
  -f, --foreground    Run in the foreground (don't detach)
  -h, --help          Show this help

Configuration (${CONFIG_PATH}):
  port            Host port (default: 7492)
  vapidSubject    VAPID subject for push notifications (default: mailto:admin@pizzapi.local)
  extraOrigins    Extra CORS origins, comma-separated

Examples:
  pizza web                           Start on default port 7492
  pizza web --port 8080               Start on port 8080 (remembered for next time)
  pizza web config set port 9000      Change port without starting
  pizza web config set extraOrigins "https://example.com"
`.trim());
}

// ─── Config subcommand ────────────────────────────────────────────────────────

const SETTABLE_KEYS = ["port", "vapidSubject", "extraOrigins"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

function runConfigSubcommand(args: string[]): void {
    const config = loadWebConfig();

    // pizza web config
    if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
        if (args[0] === "--help" || args[0] === "-h") {
            console.log(`
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

        console.log(`PizzaPi Web Config (${CONFIG_PATH}):\n`);
        console.log(`  port:          ${config.port}`);
        console.log(`  vapidSubject:  ${config.vapidSubject}`);
        console.log(`  extraOrigins:  ${config.extraOrigins || "(none)"}`);
        console.log(`  vapid.public:  ${config.vapid.publicKey.slice(0, 20)}...`);
        console.log(`  vapid.private: ${"*".repeat(20)}...`);
        return;
    }

    // pizza web config set <key> <value>
    if (args[0] === "set") {
        const key = args[1] as SettableKey;
        const value = args.slice(2).join(" ");

        if (!key || value === undefined) {
            console.error("Usage: pizza web config set <key> <value>");
            console.error(`Settable keys: ${SETTABLE_KEYS.join(", ")}`);
            process.exit(1);
        }

        if (!SETTABLE_KEYS.includes(key)) {
            console.error(`Unknown config key: ${key}`);
            console.error(`Settable keys: ${SETTABLE_KEYS.join(", ")}`);
            process.exit(1);
        }

        if (key === "port") {
            const p = parseInt(value, 10);
            if (isNaN(p) || p < 1 || p > 65535) {
                console.error("Invalid port number");
                process.exit(1);
            }
            config.port = p;
        } else {
            config[key] = value;
        }

        saveWebConfig(config);
        console.log(`Set ${key} = ${value}`);
        console.log("Run `pizza web` to apply changes.");
        return;
    }

    console.error(`Unknown config subcommand: ${args[0]}`);
    console.error("Run `pizza web config --help` for usage.");
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
            console.log("PizzaPi web is not running.");
            return;
        }
        console.log("Stopping PizzaPi web...");
        await composeExecAsync(composePath, ["down"]);
        return;
    }

    // pizza web logs
    if (subcommand === "logs") {
        ensureDocker();
        const composePath = join(WEB_DIR, "compose.yml");
        if (!existsSync(composePath)) {
            console.log("PizzaPi web is not running.");
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
            console.log("PizzaPi web is not set up. Run `pizza web` to start.");
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

    const repoPath = getRepoPath();
    const composePath = generateComposeFile(repoPath, config);

    console.log(`Starting PizzaPi web on port ${config.port}...`);
    console.log(`  Repo:    ${repoPath}`);
    console.log(`  Config:  ${CONFIG_PATH}`);
    console.log();

    if (parsed.detach) {
        await composeExecAsync(composePath, ["up", "-d", "--build"]);
        console.log();
        console.log(`✅ PizzaPi web is running at http://localhost:${config.port}`);
        console.log();
        console.log("  pizza web logs      View logs");
        console.log("  pizza web status    Check status");
        console.log("  pizza web stop      Stop the hub");
        console.log("  pizza web config    View configuration");
    } else {
        await composeExecAsync(composePath, ["up", "--build"]);
    }
}
