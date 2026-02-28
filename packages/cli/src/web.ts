/**
 * `pizza web` — Start the PizzaPi web hub (server + UI) using Docker Compose.
 *
 * Usage:
 *   pizza web                  Start the hub on port 7492
 *   pizza web --port 8080      Start on a custom port
 *   pizza web stop             Stop the hub
 *   pizza web logs             Tail logs
 *   pizza web status           Show running status
 */

import { execSync, spawn } from "child_process";
import { createECDH } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

const WEB_DIR = join(homedir(), ".pizzapi", "web");

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

function parseArgs(args: string[]): { port: number; detach: boolean } {
    let port = 7492;
    let detach = true;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port" && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            if (isNaN(port)) {
                console.error("Invalid port number");
                process.exit(1);
            }
            i++;
        }
        if (args[i] === "--foreground" || args[i] === "-f") {
            detach = false;
        }
    }

    return { port, detach };
}

function findRepoRoot(): string | null {
    // If we're running from inside the PizzaPi repo, use it
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

const REPO_URL = "https://github.com/Pizzaface/PizzaPi.git";

function getRepoPath(): string {
    const repoRoot = findRepoRoot();
    if (repoRoot) return repoRoot;

    // Check if we have a cloned repo in ~/.pizzapi/web/repo
    const clonedRepo = join(WEB_DIR, "repo");
    if (existsSync(join(clonedRepo, "Dockerfile"))) {
        // Pull latest changes
        console.log("Updating PizzaPi repository...");
        try {
            execSync("git pull --rebase", { cwd: clonedRepo, stdio: "inherit" });
        } catch {
            console.warn("Warning: Could not update repo, using existing version.");
        }
        return clonedRepo;
    }

    // Auto-clone the repo
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

function generateComposeFile(repoPath: string, port: number): string {
    const composePath = join(WEB_DIR, "compose.yml");
    mkdirSync(WEB_DIR, { recursive: true });

    // Ensure data dir for persistent auth.db
    const dataDir = join(WEB_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    if (!existsSync(composePath)) {
        const templatePath = join(import.meta.dirname ?? __dirname, "templates", "compose.yml.template");
        const template = readFileSync(templatePath, "utf-8");
        const vapid = generateVapidKeys();
        console.log("Generated persistent VAPID keys for push notifications.");

        const compose = template
            .replace(/\{\{REPO_PATH}}/g, repoPath)
            .replace(/\{\{PORT}}/g, String(port))
            .replace(/\{\{DATA_DIR}}/g, dataDir)
            .replace(/\{\{VAPID_PUBLIC_KEY}}/g, vapid.publicKey)
            .replace(/\{\{VAPID_PRIVATE_KEY}}/g, vapid.privateKey);

        writeFileSync(composePath, compose);
        console.log(`Created ${composePath}`);
    } else {
        console.log(`Using existing ${composePath}`);
    }

    return composePath;
}

function composeExec(composePath: string, args: string[], opts?: { detach?: boolean }): number {
    const child = spawn(
        "docker",
        ["compose", "-f", composePath, "-p", "pizzapi-web", ...args],
        { stdio: "inherit" }
    );

    // For foreground mode, handle signals
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const handler = (sig: NodeJS.Signals) => child.kill(sig);
    signals.forEach((sig) => process.on(sig, handler));

    return new Promise<number>((resolve) => {
        child.on("close", (code) => {
            signals.forEach((sig) => process.removeListener(sig, handler));
            resolve(code ?? 1);
        });
    }) as unknown as number;
}

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

export async function runWeb(args: string[]): Promise<void> {
    const subcommand = args[0];

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

    // pizza web (start)
    ensureDocker();

    const { port, detach } = parseArgs(
        subcommand && !subcommand.startsWith("-") ? args.slice(1) : args
    );

    const repoPath = getRepoPath();
    const composePath = generateComposeFile(repoPath, port);

    console.log(`Starting PizzaPi web on port ${port}...`);
    console.log(`  Repo:    ${repoPath}`);
    console.log(`  Config:  ${composePath}`);
    console.log();

    // Build and start
    if (detach) {
        await composeExecAsync(composePath, ["up", "-d", "--build"]);
        console.log();
        console.log(`✅ PizzaPi web is running at http://localhost:${port}`);
        console.log();
        console.log("  pizza web logs      View logs");
        console.log("  pizza web status    Check status");
        console.log("  pizza web stop      Stop the hub");
    } else {
        await composeExecAsync(composePath, ["up", "--build"]);
    }
}
