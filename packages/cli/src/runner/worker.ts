import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { defaultAgentDir, expandHome, loadConfig } from "../config.js";

/**
 * Build additional skill paths for the headless worker.
 *
 * ~/.pizzapi/skills/ is already discovered via agentDir, so we only need
 * the project-local .pizzapi/skills/ plus Claude-style agents/ directories
 * (both global and project-local) which map to pi skills.
 */
function buildSkillPaths(cwd: string, configSkills?: string[]): string[] {
    const paths: string[] = [
        join(cwd, ".pizzapi", "skills"),
        join(homedir(), ".pizzapi", "agents"),
        join(cwd, ".pizzapi", "agents"),
        join(cwd, ".agents", "skills"),
        join(cwd, ".agents", "agents"),
    ];
    if (Array.isArray(configSkills)) {
        for (const p of configSkills) {
            if (typeof p === "string" && p.trim()) {
                paths.push(expandHome(p.trim()));
            }
        }
    }
    return paths;
}

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
import { remoteExtension, forwardCliError } from "../extensions/remote.js";
import { mcpExtension } from "../extensions/mcp-extension.js";
import { restartExtension } from "../extensions/restart.js";
import { setSessionNameExtension } from "../extensions/set-session-name.js";

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
    const agentDir = config.agentDir?.replace(/^~/, process.env.HOME ?? "") ?? defaultAgentDir();

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
        extensionFactories: [remoteExtension, mcpExtension, restartExtension, setSessionNameExtension],
        additionalSkillPaths: buildSkillPaths(cwd, config.skills),
        additionalPromptTemplatePaths: buildPromptPaths(cwd),
        ...(config.systemPrompt !== undefined && {
            systemPromptOverride: () => config.systemPrompt,
        }),
        ...(config.appendSystemPrompt !== undefined && {
            appendSystemPrompt: config.appendSystemPrompt,
        }),
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
    console.log(`pizzapi worker: started (cwd=${cwd}${sessionId ? `, sessionId=${sessionId}` : ""})`);

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
