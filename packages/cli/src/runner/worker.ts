import { createAgentSession, DefaultResourceLoader, AuthStorage } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt, rewriteForClaudeCodeProvider, buildClaudeCodeProviderPrompt, defaultAgentDir, expandHome, loadConfig, resolveSandboxConfig, validateSandboxOverride, applyProviderSettingsEnv } from "../config.js";
import { buildSkillPaths, buildPromptTemplatePaths, createAgentsFilesOverride } from "../skills.js";
import { getPluginSkillPaths } from "../extensions/claude-plugins.js";
import { initSandbox, cleanupSandbox, isSandboxActive } from "@pizzapi/tools";
import { createBootTimer } from "./boot-timing.js";
import { setLogComponent, setLogSessionId, logInfo, logWarn, logError, logAuth } from "./logger.js";

/**
 * Create an AuthStorage instance with retried file locking.
 *
 * When many worker processes spawn simultaneously (e.g. 6 sub-sessions in
 * parallel), the upstream AuthStorage constructor acquires a synchronous
 * file lock on auth.json during its `reload()` call. The sync lock uses
 * only 10 retries × 20ms = ~200ms window, which is too short when another
 * process is doing an async OAuth token refresh (seconds). Workers that
 * lose the lock race silently start with empty credentials → "No API key
 * found" errors.
 *
 * This helper retries AuthStorage creation with increasing delays,
 * and if all retries fail, falls back to a lockless read so the worker
 * at least has stale-but-valid credentials rather than none.
 */
async function createAuthStorageWithRetry(authPath: string, maxAttempts = 5): Promise<AuthStorage> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const storage = AuthStorage.create(authPath);
            // Verify it actually loaded credentials (not silently empty due to lock failure)
            const providers = storage.list();
            if (providers.length > 0) {
                return storage;
            }
            // If the file exists but we got zero providers, it could be a lock failure
            // that was silently swallowed. Check if the file actually has data.
            if (existsSync(authPath)) {
                try {
                    const raw = readFileSync(authPath, "utf-8");
                    const data = JSON.parse(raw);
                    if (Object.keys(data).length > 0) {
                        // File has data but AuthStorage didn't load it — lock contention.
                        // Wait and retry.
                        logWarn(
                            `pizzapi worker: auth.json has ${Object.keys(data).length} provider(s) but AuthStorage loaded 0 (attempt ${attempt}/${maxAttempts}, likely lock contention)`,
                        );
                        lastError = new Error("Lock contention: auth.json has data but AuthStorage loaded empty");
                        if (attempt < maxAttempts) {
                            // Exponential backoff: 100ms, 200ms, 400ms, 800ms
                            await Bun.sleep(100 * Math.pow(2, attempt - 1));
                            continue;
                        }
                        // Final attempt still hit lock contention — break out of the
                        // loop so we fall through to the lockless fallback below
                        // instead of returning the empty storage.
                        break;
                    }
                } catch {
                    // Partial/empty JSON during a concurrent token refresh —
                    // retry instead of returning the empty storage (P1 fix).
                    lastError = new Error("Lockless auth.json probe got unreadable/partial JSON");
                    if (attempt < maxAttempts) {
                        await Bun.sleep(100 * Math.pow(2, attempt - 1));
                        continue;
                    }
                    break;
                }
            }
            // File genuinely empty or doesn't exist — return as-is
            return storage;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                await Bun.sleep(100 * Math.pow(2, attempt - 1));
            }
        }
    }

    // All retries failed — try a lockless fallback read so the worker has
    // at least stale-but-valid credentials rather than none.
    // Retry the lockless read a few times with short delays because a
    // concurrent writeFileSync can produce empty/partial JSON momentarily.
    logWarn(
        `pizzapi worker: AuthStorage lock retries exhausted (${maxAttempts} attempts), falling back to lockless read`,
    );
    const locklessRetries = 3;
    for (let lr = 1; lr <= locklessRetries; lr++) {
        try {
            const raw = readFileSync(authPath, "utf-8");
            if (!raw || !raw.trim()) {
                // Empty file — likely mid-write; wait and retry
                if (lr < locklessRetries) {
                    await Bun.sleep(50 * lr);
                    continue;
                }
                break;
            }
            const data = JSON.parse(raw);
            if (Object.keys(data).length > 0) {
                // The lock holder may have finished by now — try one final
                // AuthStorage.create() so we get a file-backed instance that
                // can persist token refreshes and see future credential updates.
                try {
                    const fileStorage = AuthStorage.create(authPath);
                    if (fileStorage.list().length > 0) {
                        logInfo(
                            `pizzapi worker: lock released — file-backed AuthStorage loaded ${fileStorage.list().length} provider(s) on final retry`,
                        );
                        return fileStorage;
                    }
                } catch {
                    // Still can't acquire lock — fall through to in-memory
                }
                // Use in-memory as last resort (read-only snapshot — token
                // refreshes won't be persisted and credential updates won't
                // be visible, but at least the worker can start).
                const storage = AuthStorage.inMemory(data);
                logWarn(
                    `pizzapi worker: lockless fallback loaded ${Object.keys(data).length} provider(s) from ${authPath} (in-memory snapshot — token refreshes will not persist)`,
                );
                return storage;
            }
            // Parsed OK but empty object — file genuinely has no providers
            break;
        } catch (err) {
            // Partial JSON (concurrent write) — retry
            if (lr < locklessRetries) {
                logWarn(
                    `pizzapi worker: lockless read attempt ${lr}/${locklessRetries} got bad JSON, retrying...`,
                );
                await Bun.sleep(50 * lr);
                continue;
            }
            logWarn(
                `pizzapi worker: lockless fallback read failed after ${locklessRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Truly nothing worked — return default (will fail at model selection time)
    logError(
        `pizzapi worker: failed to load auth credentials after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return AuthStorage.create(authPath);
}

// buildPromptPaths moved to ../skills.ts as buildPromptTemplatePaths
import { forwardCliError } from "../extensions/remote.js";
import { syncKeychainToAuthStorage } from "./keychain-auth.js";
import { buildPizzaPiExtensionFactories } from "../extensions/factories.js";
import { armWorkerStartupGate, markWorkerStartupComplete } from "../extensions/worker-startup-gate.js";

/**
 * Headless session worker.
 *
 * This is the backend equivalent of running `pizzapi` manually, except there is no
 * interactive TUI. Instead, extensions (notably the PizzaPi remote extension)
 * connect to the relay and accept remote input/exec from the web UI.
 *
 * Environment:
 *   PIZZAPI_WORKER_CWD   Project working directory for this session
 *   PIZZAPI_SESSION_ID   Requested relay session ID (stable identity)
 *   PIZZAPI_API_KEY      API key used by remote extension to register with relay
 *   PIZZAPI_RELAY_URL    Relay base URL (http(s)://... or ws(s)://...)
 */
async function main(): Promise<void> {
    const bootTimer = createBootTimer();
    bootTimer.start("[boot] total");

    setLogComponent("worker");
    const sessionId = process.env.PIZZAPI_SESSION_ID ?? null;
    setLogSessionId(sessionId);

    const args = process.argv.slice(2);
    const cwdFlagIdx = args.indexOf("--cwd");
    const cwdFromArgs = cwdFlagIdx !== -1 && args[cwdFlagIdx + 1] ? args[cwdFlagIdx + 1] : undefined;

    const cwd = process.env.PIZZAPI_WORKER_CWD ?? cwdFromArgs ?? process.cwd();
    try {
        process.chdir(cwd);
    } catch (err) {
        logError(`failed to chdir to ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    bootTimer.start("[boot] config");
    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
    const skipPlugins = process.env.PIZZAPI_NO_PLUGINS === "1";

    // ── Provider settings → env vars ───────────────────────────────────────
    applyProviderSettingsEnv(config);
    bootTimer.end("[boot] config");

    // ── Sandbox initialization ─────────────────────────────────────────────
    // Must happen before any tools execute (including MCP init via extensions).
    bootTimer.start("[boot] sandbox");
    const sandboxConfig = resolveSandboxConfig(cwd, config);

    // PIZZAPI_SANDBOX / PIZZAPI_NO_SANDBOX env var overrides.
    // validateSandboxOverride() resolves aliases (enforce→full, audit→basic, off→none)
    // and throws on unrecognised values so operators get a clear error.
    const sandboxOverrideRaw = process.env.PIZZAPI_NO_SANDBOX === "1" ? "off" : process.env.PIZZAPI_SANDBOX;
    const sandboxOverride = validateSandboxOverride(sandboxOverrideRaw);
    if (sandboxOverride === "none") {
        sandboxConfig.mode = "none";
        sandboxConfig.srtConfig = null;
    } else if (sandboxOverride === "basic" || sandboxOverride === "full") {
        // Re-resolve with the overridden mode so srtConfig matches the new preset,
        // not just the mode string.
        const overrideConfig = { ...config, sandbox: { ...(config.sandbox ?? {}), mode: sandboxOverride } };
        const overridden = resolveSandboxConfig(cwd, overrideConfig);
        sandboxConfig.mode = overridden.mode;
        sandboxConfig.srtConfig = overridden.srtConfig;
    }

    try {
        await initSandbox(sandboxConfig);
    } catch (err) {
        logWarn(`sandbox init failed, continuing unsandboxed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (isSandboxActive()) {
        process.env.PIZZAPI_SANDBOX_ACTIVE = "1";
        process.env.PIZZAPI_SANDBOX_MODE = sandboxConfig.mode;
    } else if (sandboxConfig.mode !== "none") {
        logWarn("sandbox was requested but is not active (platform unsupported or init failed)");
    }
    bootTimer.end("[boot] sandbox");

    // ── Agent session config ───────────────────────────────────────────────
    // When spawned "as" an agent, these env vars carry the agent definition.
    const agentName = process.env.PIZZAPI_WORKER_AGENT_NAME?.trim() || undefined;
    const agentSystemPrompt = process.env.PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT?.trim() || undefined;
    // Don't clear — agent config should persist across restarts (exit code 43).

    // Build shared agentsFilesOverride (loads AGENTS.md + .agents/*.md from cwd,
    // deduplicating against what DefaultResourceLoader already discovers).
    const agentsFilesOverride = createAgentsFilesOverride(cwd);

    bootTimer.start("[boot] resource-loader");
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: buildPizzaPiExtensionFactories({
            cwd,
            hooks: process.env.PIZZAPI_NO_HOOKS === "1" ? undefined : config.hooks,
            includeInitialPrompt: true,
            skipMcp: process.env.PIZZAPI_NO_MCP === "1",
            skipPlugins,
            skipRelay: process.env.PIZZAPI_NO_RELAY === "1",
        }),
        additionalSkillPaths: [
            ...buildSkillPaths(cwd, config.skills),
            ...(skipPlugins ? [] : getPluginSkillPaths(cwd)),
        ],
        additionalPromptTemplatePaths: buildPromptTemplatePaths(cwd),
        ...(config.systemPrompt !== undefined
            ? { systemPromptOverride: () => config.systemPrompt }
            : config.claudeCodeProvider
                ? { systemPromptOverride: () => buildClaudeCodeProviderPrompt({ cwd }) }
                : {}
        ),
        appendSystemPrompt: (() => {
            const parts = [buildSystemPrompt({ cwd, isRunner: true }), config.appendSystemPrompt, agentSystemPrompt].filter(Boolean) as string[];
            return config.claudeCodeProvider ? parts.map(rewriteForClaudeCodeProvider) : parts;
        })(),
        ...(agentsFilesOverride && { agentsFilesOverride }),
    });
    await loader.reload();
    bootTimer.end("[boot] resource-loader");

    // Create AuthStorage with retry logic to handle lock contention when
    // multiple workers spawn simultaneously (common with parallel sub-sessions).
    const authPath = join(agentDir, "auth.json");
    const authStorage = await createAuthStorageWithRetry(authPath);

    // ── Keychain enrichment (macOS) ─────────────────────────────────────
    // If Claude Code has a fresher Anthropic token in the Keychain, inject
    // it into our in-memory AuthStorage so this worker uses it immediately.
    try { syncKeychainToAuthStorage(authStorage); } catch {}

    // ── Auth diagnostics — log credential state before first API call ────
    // This helps diagnose intermittent "No API key found" failures in
    // concurrent worker sessions (see Godmother idea fIUvBDLZ).
    try {
        for (const provider of ["anthropic", "google-gemini-cli", "openai-codex"]) {
            const raw = authStorage.get(provider);
            if (raw && typeof raw === "object" && "type" in raw) {
                const cred = raw as { type: string; expires?: number };
                if (cred.type === "oauth" && cred.expires) {
                    const remainingMs = cred.expires - Date.now();
                    logAuth("credential-state", {
                        provider,
                        type: cred.type,
                        expiresIn: `${Math.round(remainingMs / 1000)}s`,
                        expired: remainingMs <= 0 ? "YES" : "no",
                    });
                } else {
                    logAuth("credential-state", { provider, type: cred.type });
                }
            } else if (raw) {
                logAuth("credential-state", { provider, type: "unknown-format" });
            }
            // Silently skip missing providers — not all may be configured
        }
    } catch {
        // Non-fatal — diagnostic only
    }

    bootTimer.start("[boot] create-session");
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        authStorage,
        resourceLoader: loader,
    });
    bootTimer.end("[boot] create-session");

    // Bind extensions in headless mode (no UI context)
    // Arm the startup gate before session_start handlers run so inbound relay
    // triggers / remote input cannot start the first turn until all startup
    // work (notably MCP initialization) has completed.
    armWorkerStartupGate();
    bootTimer.start("[boot] bind-extensions");
    try {
    await session.bindExtensions({
        commandContextActions: {
            waitForIdle: () => session.agent.waitForIdle(),
            // Headless runner sessions don't switch/fork — return cancelled for all
            newSession: async () => ({ cancelled: true }),
            fork: async () => ({ cancelled: true }),
            navigateTree: async () => ({ cancelled: true }),
            switchSession: async () => ({ cancelled: true }),
            reload: async () => {
                await session.reload();
            },
        },
        shutdownHandler: () => {
            try {
                session.dispose();
            } finally {
                process.exit(0);
            }
        },
        onError: (err) => {
            logError(`[extension] ${err.extensionPath}: ${err.error}`);
            if (err.stack) logError(err.stack);
            forwardCliError(err.error, err.extensionPath);
        },
    });
    } finally {
        // Always release the gate — even if bindExtensions() throws — so that
        // any callers already waiting on waitForWorkerStartupComplete() are not
        // stranded forever. The worker will crash/exit on throw anyway.
        markWorkerStartupComplete();
    }
    bootTimer.end("[boot] bind-extensions");

    bootTimer.end("[boot] total");
    logInfo(`started (cwd=${cwd}${agentName ? `, agent=${agentName}` : ""})`);

    const shutdown = async () => {
        try {
            await cleanupSandbox();
        } catch {}
        try {
            session.dispose();
        } catch {}
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // Keep the process alive; work happens via relay/websocket events.
    await new Promise<void>(() => {});
}

main().catch((err) => {
    logError(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
});
