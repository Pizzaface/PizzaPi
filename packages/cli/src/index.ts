import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    InteractiveMode,
    ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { defaultAgentDir, loadConfig } from "./config.js";
import { remoteExtension } from "./extensions/remote.js";
import { mcpExtension } from "./extensions/mcp-extension.js";
import { restartExtension } from "./extensions/restart.js";
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

    if (args[0] === "usage") {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? config.agentDir.replace(/^~/, process.env.HOME ?? "") : defaultAgentDir();
        const authStorage = AuthStorage.create(join(agentDir, "auth.json"));

        const accessToken = await authStorage.getApiKey("anthropic");
        if (!accessToken) {
            console.error("No Anthropic credentials found. Log in with /login inside pizzapi.");
            process.exit(1);
        }

        let res: Response;
        try {
            res = await fetch("https://api.anthropic.com/api/oauth/usage", {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "oauth-2025-04-20",
                },
            });
        } catch (err) {
            const cause = err instanceof Error && (err as any).cause instanceof Error ? (err as any).cause.message : null;
            const detail = cause ?? (err instanceof Error ? err.message : String(err));
            console.error(`Failed to fetch usage: network error (${detail})`);
            process.exit(1);
        }

        if (!res.ok) {
            console.error(`Failed to fetch usage: HTTP ${res.status} ${res.statusText}`);
            try {
                const body = await res.text();
                if (body) console.error(body);
            } catch {
                // ignore body read errors
            }
            process.exit(1);
        }

        type UsageWindow = { utilization: number; resets_at: string } | null;
        type ExtraUsage = { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null };
        type UsageResponse = {
            five_hour: UsageWindow;
            seven_day: UsageWindow;
            seven_day_oauth_apps: UsageWindow;
            seven_day_opus: UsageWindow;
            seven_day_sonnet: UsageWindow;
            seven_day_cowork: UsageWindow;
            extra_usage: ExtraUsage;
            [key: string]: unknown;
        };
        let usage: UsageResponse;
        try {
            usage = (await res.json()) as UsageResponse;
        } catch (err) {
            console.error(`Failed to parse usage response: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }

        if (args.includes("--json")) {
            console.log(JSON.stringify(usage, null, 2));
            return;
        }

        const formatWindow = (label: string, w: UsageWindow) => {
            if (!w) return;
            const pct = `${w.utilization.toFixed(1)}%`;
            const reset = new Date(w.resets_at).toLocaleString();
            console.log(`  ${label.padEnd(22)} ${pct.padStart(6)}  (resets ${reset})`);
        };

        console.log("\nClaude usage (OAuth subscription)");
        console.log("─".repeat(58));
        formatWindow("5-hour window", usage.five_hour);
        formatWindow("7-day window", usage.seven_day);
        formatWindow("7-day (OAuth apps)", usage.seven_day_oauth_apps);
        formatWindow("7-day (Opus)", usage.seven_day_opus);
        formatWindow("7-day (Sonnet)", usage.seven_day_sonnet);
        formatWindow("7-day (co-work)", usage.seven_day_cowork);

        const ex = usage.extra_usage;
        if (ex?.is_enabled) {
            console.log(`\n  Extra usage enabled`);
            if (ex.monthly_limit != null) console.log(`    Monthly limit:   $${ex.monthly_limit}`);
            if (ex.used_credits != null) console.log(`    Credits used:    $${ex.used_credits}`);
            if (ex.utilization != null) console.log(`    Utilization:     ${ex.utilization.toFixed(1)}%`);
        }
        console.log();
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
        const files = await readdir(dotAgentsDir);
        const mdFiles = files.filter((file) => file.endsWith(".md"));
        const loadedAgents = await Promise.all(
            mdFiles.map(async (file) => {
                const filePath = join(dotAgentsDir, file);
                const content = await readFile(filePath, "utf-8");
                return { path: filePath, content };
            })
        );
        agentFiles.push(...loadedAgents);
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
