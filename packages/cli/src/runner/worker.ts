import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentDir, loadConfig } from "../config.js";
import { remoteExtension } from "../extensions/remote.js";
import { mcpExtension } from "../extensions/mcp-extension.js";
import { restartExtension } from "../extensions/restart.js";

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
        extensionFactories: [remoteExtension, mcpExtension, restartExtension],
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
