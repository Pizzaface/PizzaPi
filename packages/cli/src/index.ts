import {
    createAgentSession,
    DefaultResourceLoader,
    InteractiveMode,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { defaultAgentDir, loadConfig } from "./config.js";
import { remoteExtension } from "./extensions/remote.js";
import { runSetup } from "./setup.js";

async function main() {
    const args = process.argv.slice(2);
    const cwd = process.cwd();

    // Sub-command dispatch
    if (args[0] === "runner") {
        const { runDaemon } = await import("./runner/daemon.js");
        await runDaemon(args.slice(1));
        return;
    }

    if (args[0] === "setup") {
        await runSetup({ force: true });
        return;
    }

    if (args.includes("--version") || args.includes("-v")) {
        const pkgPath = new URL("../package.json", import.meta.url);
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        console.log(`pizzapi v${pkg.version}`);
        return;
    }

    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? config.agentDir.replace(/^~/, process.env.HOME ?? "") : defaultAgentDir();

    // First-run: no API key configured — prompt setup before launching TUI
    const hasApiKey = !!(process.env.PIZZAPI_API_KEY ?? config.apiKey);
    const relayDisabled = (process.env.PIZZAPI_RELAY_URL ?? "").toLowerCase() === "off";
    if (!hasApiKey && !relayDisabled) {
        await runSetup();
    }

    // Load .agents/*.md files from cwd
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
        extensionFactories: [remoteExtension],
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

    const { session, modelFallbackMessage } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
    });

    const mode = new InteractiveMode(session, {
        modelFallbackMessage,
    });
    await mode.run();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
