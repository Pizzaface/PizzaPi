/**
 * `pizza local` — One-command local-first PizzaPi startup.
 *
 * This is a thin sequencer over the existing relay/UI, setup, and runner
 * commands. It does not duplicate their config, process, or health logic.
 *
 * Ownership:
 *   - Relay + web UI are started/reused via `runWeb()` (Docker Compose) and
 *     remain managed by `pizza web` / `pizza web stop`. They keep running
 *     after this command exits.
 *   - Runner is started in the foreground via `runSupervisor()`. This command
 *     owns the process, so Ctrl+C stops the runner without leaving an orphan
 *     daemon behind.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "./cli-colors.js";
import { createLogger } from "@pizzapi/tools";
import { loadGlobalConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { runWeb } from "./web.js";
import { runSupervisor } from "./runner/supervisor.js";
import { defaultStatePath, isPidRunning } from "./runner/runner-state.js";

const log = createLogger("local");

const DEFAULT_PORT = 7492;
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 1_000;

export interface LocalArgs {
    port: number;
    noBrowser: boolean;
    help: boolean;
}

export interface LocalPlan {
    startRelay: boolean;
    runSetup: boolean;
    startRunner: boolean;
    openBrowser: boolean;
    note?: string;
    fatal?: string;
}

export interface LocalDeps {
    runWeb: (args: string[]) => Promise<void>;
    runSetup: (opts: { force?: boolean; relayDefault?: string }) => Promise<boolean>;
    runSupervisor: () => Promise<number>;
    loadGlobalConfig: () => Partial<{ apiKey?: string; relayUrl?: string }>;
    pollRelayHealth: (relayUrl: string, opts?: { timeoutMs?: number; pollMs?: number }) => Promise<boolean>;
    isRunnerRunning: () => boolean;
    openBrowser: (url: string) => void;
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    processExit: (code: number) => never;
}

export function parseLocalArgs(args: string[]): LocalArgs {
    const result: LocalArgs = { port: DEFAULT_PORT, noBrowser: false, help: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--no-browser") {
            result.noBrowser = true;
        } else if (arg === "--port") {
            const value = args[i + 1];
            const p = value && /^\d+$/.test(value) ? Number(value) : NaN;
            if (!Number.isFinite(p) || p < 1 || p > 65535) {
                log.error("Invalid port number");
                process.exit(1);
            }
            result.port = p;
            i++;
        } else if (arg === "--help" || arg === "-h") {
            result.help = true;
        }
    }
    return result;
}

export function printLocalHelp(): void {
    log.info("");
    log.info(`${c.brand("pizza local")} ${c.dim("— Start the local relay + runner in one command")}`);
    log.info("");
    log.info("Starts the local PizzaPi relay and web UI (via `pizza web`),");
    log.info("guides through first-time setup if needed, then starts the runner");
    log.info("in the foreground. The relay keeps running after this command exits;");
    log.info("stop it with `pizza web stop`.");
    log.info("");
    log.info(c.label("Flags"));
    log.info(`  ${c.flag("--port")} ${c.dim("<port>")}  Use a custom relay port ${c.dim("(default: 7492)")}`);
    log.info(`  ${c.flag("--no-browser")}  Don't open the browser, just print the URL`);
    log.info(`  ${c.flag("-h, --help")}  Show this help`);
    log.info("");
    log.info(c.label("Examples"));
    log.info(`  ${c.dim("pizza local")}              Start local relay and runner`);
    log.info(`  ${c.dim("pizza local --port 8080")}  Use port 8080`);
    log.info("");
}

// The relay/ws URLs pin 127.0.0.1: Docker's short-form port publish binds the
// IPv4 wildcard only, while `localhost` can resolve to `::1` first (notably on
// native Windows), making health checks and runner connects fail. The browser
// URL keeps `localhost` — browsers fall back across address families themselves.
export function buildLocalRelayUrl(port: number): string {
    return `http://127.0.0.1:${port}`;
}

export function buildLocalWsRelayUrl(port: number): string {
    return `ws://127.0.0.1:${port}`;
}

export function buildLocalBrowserUrl(port: number): string {
    return `http://localhost:${port}`;
}

export function isLocalRelayUrl(relayUrl: string | undefined, port: number): boolean {
    if (!relayUrl) return false;
    const normalized = relayUrl
        .replace(/^wss?:\/\//, "")
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "");
    return normalized === `localhost:${port}` || normalized === `127.0.0.1:${port}`;
}

export function hasLocalCredentials(
    config: Partial<{ apiKey?: string; relayUrl?: string }>,
    port: number,
): boolean {
    return !!config.apiKey && isLocalRelayUrl(config.relayUrl, port);
}

export function isRemoteConfig(
    config: Partial<{ apiKey?: string; relayUrl?: string }>,
    port: number,
): boolean {
    return !!config.apiKey && !!config.relayUrl && !isLocalRelayUrl(config.relayUrl, port);
}

export function planLocalActions(opts: {
    relayHealthy: boolean;
    hasLocalApiKey: boolean;
    hasRemoteConfig: boolean;
    runnerRunning: boolean;
    noBrowser: boolean;
}): LocalPlan {
    if (opts.hasRemoteConfig && !opts.hasLocalApiKey) {
        return {
            startRelay: false,
            runSetup: false,
            startRunner: false,
            openBrowser: false,
            fatal: "A remote relay is already configured. Run `pizzapi setup` to switch to the local relay, or start the runner manually with PIZZAPI_RELAY_URL set.",
        };
    }
    if (!opts.relayHealthy) {
        return { startRelay: true, runSetup: false, startRunner: false, openBrowser: false };
    }
    if (!opts.hasLocalApiKey) {
        return { startRelay: false, runSetup: true, startRunner: false, openBrowser: false };
    }
    return {
        startRelay: false,
        runSetup: false,
        startRunner: !opts.runnerRunning,
        openBrowser: !opts.noBrowser,
        note: opts.runnerRunning ? "Runner is already running." : undefined,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export async function pollRelayHealth(
    relayUrl: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? HEALTH_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `${relayUrl.replace(/\/$/, "")}/api/signup-status`;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(pollMs) });
            if (res.ok) return true;
        } catch {
            // not ready yet
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
    }
    return false;
}

export function isRunnerRunning(): boolean {
    const statePath = defaultStatePath();
    if (!existsSync(statePath)) return false;
    let state: { pid?: number; supervisorPid?: number };
    try {
        state = JSON.parse(readFileSync(statePath, "utf-8")) as { pid?: number; supervisorPid?: number };
    } catch {
        return false;
    }
    const supervisorPid = typeof state.supervisorPid === "number" ? state.supervisorPid : 0;
    const pid = typeof state.pid === "number" ? state.pid : 0;
    if (supervisorPid > 0 && isPidRunning(supervisorPid)) return true;
    if (pid > 0 && isPidRunning(pid)) return true;
    return false;
}

export function openBrowserCommand(): { command: string; args: string[] } {
    const url = "__URL__";
    switch (process.platform) {
        case "darwin":
            return { command: "open", args: [url] };
        case "win32":
            return { command: "cmd", args: ["/c", "start", "", url] };
        default:
            return { command: "xdg-open", args: [url] };
    }
}

export function openBrowser(url: string): void {
    const { command, args } = openBrowserCommand();
    const resolvedArgs = args.map((a) => (a === "__URL__" ? url : a));
    try {
        const child = spawn(command, resolvedArgs, { stdio: "ignore" });
        child.on("error", (err) => log.warn(`Could not open browser: ${err.message}`));
        child.unref();
    } catch (err) {
        log.warn(`Could not open browser: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function defaultLocalDeps(): LocalDeps {
    return {
        runWeb,
        runSetup,
        runSupervisor,
        loadGlobalConfig,
        pollRelayHealth,
        isRunnerRunning,
        openBrowser,
        log: {
            info: (msg) => log.info(msg),
            warn: (msg) => log.warn(msg),
            error: (msg) => log.error(msg),
        },
        processExit: (code) => process.exit(code),
    };
}

export async function runLocal(args: string[] = [], deps: LocalDeps = defaultLocalDeps()): Promise<void> {
    const parsed = parseLocalArgs(args);
    if (parsed.help) {
        printLocalHelp();
        return;
    }

    const port = parsed.port;
    const relayUrl = buildLocalRelayUrl(port);
    const wsRelayUrl = buildLocalWsRelayUrl(port);
    const browserUrl = buildLocalBrowserUrl(port);

    deps.log.info("");
    deps.log.info(`${c.brand("🍕 PizzaPi local")} ${c.dim(`— relay on port ${port}`)}`);
    deps.log.info("");

    // Decide what to do based on current state.
    const initialHealthy = await deps.pollRelayHealth(relayUrl, { timeoutMs: 2_000, pollMs: 500 });
    const config = deps.loadGlobalConfig();
    const initialPlan = planLocalActions({
        relayHealthy: initialHealthy,
        hasLocalApiKey: hasLocalCredentials(config, port),
        hasRemoteConfig: isRemoteConfig(config, port),
        runnerRunning: deps.isRunnerRunning(),
        noBrowser: parsed.noBrowser,
    });

    if (initialPlan.fatal) {
        deps.log.error(`\n${c.error("✗")} ${initialPlan.fatal}`);
        deps.log.info(`  Relay/UI is at ${c.accent(browserUrl)}`);
        deps.processExit(1);
    }

    // Start the relay if it is not already healthy.
    if (initialPlan.startRelay) {
        deps.log.info("Starting local relay + web UI (this may take a minute)…");
        const webArgs = port !== DEFAULT_PORT ? ["--port", String(port)] : [];
        await deps.runWeb(webArgs);
        const healthy = await deps.pollRelayHealth(relayUrl);
        if (!healthy) {
            deps.log.error(`\n${c.error("✗")} Local relay did not become healthy.`);
            deps.log.error("  Check Docker status and run `pizza web logs` for details.");
            deps.processExit(1);
        }
    } else {
        deps.log.info(`Local relay is already healthy at ${c.accent(relayUrl)}`);
    }

    // Re-evaluate after any relay start.
    const postRelayConfig = deps.loadGlobalConfig();
    const postPlan = planLocalActions({
        relayHealthy: true,
        hasLocalApiKey: hasLocalCredentials(postRelayConfig, port),
        hasRemoteConfig: isRemoteConfig(postRelayConfig, port),
        runnerRunning: deps.isRunnerRunning(),
        noBrowser: parsed.noBrowser,
    });

    if (postPlan.fatal) {
        deps.log.error(`\n${c.error("✗")} ${postPlan.fatal}`);
        deps.log.info(`  Relay/UI is at ${c.accent(browserUrl)}`);
        deps.processExit(1);
    }

    // Mutable outcome flags. Setup may change the credential state, so we may
    // need to update these after the setup block below.
    let startRunner = postPlan.startRunner;
    let openBrowser = postPlan.openBrowser;
    let note = postPlan.note;

    if (postPlan.runSetup) {
        deps.log.info("\nNo local API key found. Starting first-time setup…");
        const ok = await deps.runSetup({ force: false, relayDefault: relayUrl });
        if (!ok) {
            deps.log.info("\nSetup cancelled. The relay is running; run `pizza local` again to complete setup.");
            return;
        }
        const afterSetup = deps.loadGlobalConfig();
        if (!hasLocalCredentials(afterSetup, port)) {
            deps.log.error("\nSetup completed but no local API key was saved.");
            deps.log.info("The relay is running. Run `pizza local` again to retry.");
            return;
        }
        // Credentials are now present; decide runner/browser like a normal
        // post-setup plan.
        const runnerRunning = deps.isRunnerRunning();
        startRunner = !runnerRunning;
        openBrowser = !parsed.noBrowser;
        note = runnerRunning ? "Runner is already running." : undefined;
    }

    // Open or link the browser UI.
    if (openBrowser) {
        deps.log.info(`\nOpening ${c.accent(browserUrl)}…`);
        deps.openBrowser(browserUrl);
    } else {
        deps.log.info(`\nLocal UI: ${c.accent(browserUrl)}`);
    }

    if (note) {
        deps.log.info(note);
    }

    // Start the runner in the foreground unless it is already running.
    if (!startRunner) {
        deps.log.info("\nLocal PizzaPi is ready.");
        deps.log.info(`  Relay/UI: ${c.accent(browserUrl)}`);
        if (note) deps.log.info(`  Runner: ${note.toLowerCase()}`);
        deps.log.info("\nThe relay keeps running. Stop it with `pizza web stop`.");
        return;
    }

    deps.log.info("\nStarting runner in the foreground…");
    deps.log.info("Press Ctrl+C to stop the runner. The relay keeps running.\n");
    const code = await deps.runSupervisor();
    deps.processExit(code);
}
