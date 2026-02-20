import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    InteractiveMode,
    ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { defaultAgentDir, loadConfig } from "./config.js";
import { remoteExtension } from "./extensions/remote.js";
import { mcpExtension } from "./extensions/mcp-extension.js";
import { runSetup } from "./setup.js";

async function main() {
    const args = process.argv.slice(2);
    const cwdFlagIdx = args.indexOf("--cwd");
    const cwd = cwdFlagIdx !== -1 && args[cwdFlagIdx + 1] ? args[cwdFlagIdx + 1] : process.cwd();
    if (cwdFlagIdx !== -1) {
        // remove --cwd <path> so pi doesn't interpret it
        args.splice(cwdFlagIdx, 2);
    }

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

    if (args[0] === "models") {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? config.agentDir.replace(/^~/, process.env.HOME ?? "") : defaultAgentDir();

        const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
        const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
        const configuredModels = modelRegistry
            .getAvailable()
            .map((model) => ({
                provider: model.provider,
                id: model.id,
                name: model.name,
                contextWindow: model.contextWindow,
                reasoning: model.reasoning,
            }))
            .sort((a, b) => {
                if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                return a.id.localeCompare(b.id);
            });

        if (args.includes("--json")) {
            console.log(JSON.stringify({ models: configuredModels }, null, 2));
            return;
        }

        if (configuredModels.length === 0) {
            console.log("No configured models found.");
            console.log(`Checked credentials in ${join(agentDir, "auth.json")}`);
            return;
        }

        const providerWidth = Math.max(...configuredModels.map((m) => m.provider.length), "provider".length);
        const modelWidth = Math.max(...configuredModels.map((m) => m.id.length), "model".length);

        console.log(`${"provider".padEnd(providerWidth)}  ${"model".padEnd(modelWidth)}  notes`);
        console.log(`${"-".repeat(providerWidth)}  ${"-".repeat(modelWidth)}  -----`);
        for (const model of configuredModels) {
            const notes = [
                model.reasoning ? "reasoning" : undefined,
                model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : undefined,
                model.name && model.name !== model.id ? model.name : undefined,
            ].filter(Boolean).join(" • ");
            console.log(`${model.provider.padEnd(providerWidth)}  ${model.id.padEnd(modelWidth)}  ${notes}`);
        }
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
        extensionFactories: [remoteExtension, mcpExtension],
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
