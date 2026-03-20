import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_SYSTEM_PROMPT, defaultAgentDir, expandHome, loadConfig, resolveSandboxConfig, validateSandboxOverride, applyProviderSettingsEnv } from "../config.js";
import { buildWorkerSkillPaths } from "../skills.js";
import { getPluginSkillPaths } from "../extensions/claude-plugins.js";
import { initSandbox, cleanupSandbox, isSandboxActive } from "@pizzapi/tools";
import { createBootTimer } from "./boot-timing.js";
import { setLogComponent, setLogSessionId, logInfo, logWarn, logError, logAuth } from "./logger.js";

/**
 * Build additional prompt template paths for the headless worker.
 *
 * ~/.pizzapi/prompts/ is already discovered via agentDir, so we only need
 * the project-local .pizzapi/prompts/ plus Claude-style commands/ directories
 * (both global and project-local) which map to pi prompt templates.
 */
function buildPromptPaths(cwd: string): string[] {
    return [
        join(cwd, ".pizzapi", "prompts"),
        join(homedir(), ".pizzapi", "commands"),
        join(cwd, ".pizzapi", "commands"),
        join(cwd, ".agents", "commands"),
    ];
}
import { forwardCliError } from "../extensions/remote.js";
import { buildPizzaPiExtensionFactories } from "../extensions/factories.js";

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

    // Load .agents/*.md files from cwd (same behavior as CLI)
    const dotAgentsDir = join(cwd, ".agents");
    const agentFiles: Array<{ path: string; content: string }> = [];
    if (existsSync(dotAgentsDir)) {
        for (const file of readdirSync(dotAgentsDir)) {
            if (file.endsWith(".md")) {
                const filePath = join(dotAgentsDir, file);
                try {
                    agentFiles.push({ path: filePath, content: readFileSync(filePath, "utf-8") });
                } catch (err) {
                    logWarn(`skipping unreadable agent file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }

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
            ...buildWorkerSkillPaths(cwd, config.skills),
            ...(skipPlugins ? [] : getPluginSkillPaths(cwd)),
        ],
        additionalPromptTemplatePaths: buildPromptPaths(cwd),
        ...(config.systemPrompt !== undefined && {
            systemPromptOverride: () => config.systemPrompt,
        }),
        appendSystemPrompt: [BUILTIN_SYSTEM_PROMPT, config.appendSystemPrompt, agentSystemPrompt].filter(Boolean).join("\n\n"),
        ...(agentFiles.length > 0 && {
            agentsFilesOverride: (base) => ({
                agentsFiles: [...base.agentsFiles, ...agentFiles],
            }),
        }),
    });
    await loader.reload();
    bootTimer.end("[boot] resource-loader");

    // ── Auth diagnostics — log credential state before first API call ────
    // This helps diagnose intermittent "No API key found" failures in
    // concurrent worker sessions (see Godmother idea fIUvBDLZ).
    try {
        const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
        const diagAuthStorage = AuthStorage.create(join(agentDir, "auth.json"));
        for (const provider of ["anthropic", "google-gemini-cli", "openai-codex"]) {
            const raw = diagAuthStorage.get(provider);
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
        resourceLoader: loader,
    });
    bootTimer.end("[boot] create-session");

    // Bind extensions in headless mode (no UI context)
    bootTimer.start("[boot] bind-extensions");
    await session.bindExtensions({
        commandContextActions: {
            waitForIdle: () => session.agent.waitForIdle(),
            newSession: async (options) => {
                const success = await session.newSession(options);
                return { cancelled: !success };
            },
            fork: async (entryId) => {
                const result = await session.fork(entryId);
                return { cancelled: result.cancelled };
            },
            navigateTree: async (targetId, options) => {
                const result = await session.navigateTree(targetId, {
                    summarize: options?.summarize,
                    customInstructions: options?.customInstructions,
                    replaceInstructions: options?.replaceInstructions,
                    label: options?.label,
                });
                return { cancelled: result.cancelled };
            },
            switchSession: async (sessionPath) => {
                const success = await session.switchSession(sessionPath);
                return { cancelled: !success };
            },
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
