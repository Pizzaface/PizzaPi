import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILTIN_SYSTEM_PROMPT, defaultAgentDir, loadConfig } from "../config.js";
import { buildWorkerSkillPaths } from "../skills.js";
import { getPluginSkillPaths } from "../extensions/claude-plugins.js";

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
    const args = process.argv.slice(2);
    const cwdFlagIdx = args.indexOf("--cwd");
    const cwdFromArgs = cwdFlagIdx !== -1 && args[cwdFlagIdx + 1] ? args[cwdFlagIdx + 1] : undefined;

    const cwd = process.env.PIZZAPI_WORKER_CWD ?? cwdFromArgs ?? process.cwd();
    try {
        process.chdir(cwd);
    } catch (err) {
        console.error(`pizzapi worker: failed to chdir to ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    const config = loadConfig(cwd);
    const agentDir = config.agentDir?.replace(/^~/, homedir()) ?? defaultAgentDir();
    const skipPlugins = process.env.PIZZAPI_NO_PLUGINS === "1";

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
                agentFiles.push({ path: filePath, content: readFileSync(filePath, "utf-8") });
            }
        }
    }

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

    const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
    });

    // Bind extensions in headless mode (no UI context)
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
            console.error(`[extension] ${err.extensionPath}: ${err.error}`);
            if (err.stack) console.error(err.stack);
            forwardCliError(err.error, err.extensionPath);
        },
    });

    const sessionId = process.env.PIZZAPI_SESSION_ID;
    console.log(`pizzapi worker: started (cwd=${cwd}${sessionId ? `, sessionId=${sessionId}` : ""}${agentName ? `, agent=${agentName}` : ""})`);

    const shutdown = () => {
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
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
});
