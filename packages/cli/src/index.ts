#!/usr/bin/env bun
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    InteractiveMode,
    ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { defaultAgentDir, expandHome, loadConfig } from "./config.js";

/**
 * Build the list of additional skill paths for DefaultResourceLoader.
 * Always includes:
 *   - ~/.pizzapi/skills/  (global PizzaPi skills)
 *   - <cwd>/.pizzapi/skills/  (project-local PizzaPi skills)
 * Plus any paths declared in config.skills.
 */
function buildSkillPaths(cwd: string, _agentDir: string, configSkills?: string[]): string[] {
    const paths: string[] = [
        join(homedir(), ".pizzapi", "skills"),
        join(cwd, ".pizzapi", "skills"),
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
import { remoteExtension } from "./extensions/remote.js";
import { mcpExtension } from "./extensions/mcp-extension.js";
import { restartExtension } from "./extensions/restart.js";
import { setSessionNameExtension } from "./extensions/set-session-name.js";
import { updateTodoExtension } from "./extensions/update-todo.js";
import { spawnSessionExtension } from "./extensions/spawn-session.js";
import { getSessionStatusExtension } from "./extensions/get-session-status.js";
import { sessionMessagingExtension } from "./extensions/session-messaging.js";
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

    // `runner` → outer supervisor (spawns daemon as a child process so that a
    //   crash in the PTY layer only kills the child, not the supervisor).
    if (args[0] === "runner" && args[1] === "stop") {
        const { runStop } = await import("./runner/stop.js");
        const code = await runStop();
        process.exit(code);
    }

    if (args[0] === "runner") {
        const { runSupervisor } = await import("./runner/supervisor.js");
        const code = await runSupervisor(args.slice(1));
        process.exit(code);
    }

    // `_daemon` → internal entrypoint used by the supervisor subprocess.
    //   Not intended to be called directly; the supervisor sets this arg when
    //   it spawns the daemon child so that the daemon runs without any restart
    //   loop of its own (restarts are the supervisor's responsibility).
    if (args[0] === "_daemon") {
        const { runDaemon } = await import("./runner/daemon.js");
        const code = await runDaemon(args.slice(1));
        process.exit(code);
    }

    if (args[0] === "setup") {
        await runSetup({ force: true });
        return;
    }

    if (args[0] === "usage") {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? config.agentDir.replace(/^~/, process.env.HOME ?? "") : defaultAgentDir();
        const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
        const showJson = args.includes("--json");

        // Determine which provider(s) to show
        const providerArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const showAnthropic = !providerArg || providerArg === "anthropic";
        const showGemini = !providerArg || providerArg === "gemini";

        let printedAny = false;

        // ── Anthropic ──────────────────────────────────────────────────────────
        if (showAnthropic) {
            const accessToken = await authStorage.getApiKey("anthropic");
            if (!accessToken) {
                if (providerArg === "anthropic") {
                    console.error("No Anthropic credentials found. Log in with /login inside pizzapi.");
                    process.exit(1);
                }
                // silently skip when showing all providers
            } else {
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
                    console.error(`Failed to fetch Anthropic usage: network error (${detail})`);
                    process.exit(1);
                }

                if (!res.ok) {
                    console.error(`Failed to fetch Anthropic usage: HTTP ${res.status} ${res.statusText}`);
                    try {
                        const body = await res.text();
                        if (body) console.error(body);
                    } catch { /* ignore */ }
                    process.exit(1);
                }

                type UsageWindow = { utilization: number; resets_at: string } | null;
                type ExtraUsage = { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null };
                type AnthropicUsageResponse = {
                    five_hour: UsageWindow;
                    seven_day: UsageWindow;
                    seven_day_oauth_apps: UsageWindow;
                    seven_day_opus: UsageWindow;
                    seven_day_sonnet: UsageWindow;
                    seven_day_cowork: UsageWindow;
                    extra_usage: ExtraUsage;
                    [key: string]: unknown;
                };
                let usage: AnthropicUsageResponse;
                try {
                    usage = (await res.json()) as AnthropicUsageResponse;
                } catch (err) {
                    console.error(`Failed to parse Anthropic usage response: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }

                if (showJson) {
                    console.log(JSON.stringify({ provider: "anthropic", usage }, null, 2));
                    printedAny = true;
                } else {
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
                    printedAny = true;
                }
            }
        }

        // ── Gemini (Google Cloud Code Assist, OAuth) ───────────────────────────
        if (showGemini) {
            const rawCred = await authStorage.getApiKey("google-gemini-cli");
            if (!rawCred) {
                if (providerArg === "gemini") {
                    console.error("No Gemini credentials found. Log in with /login inside pizzapi.");
                    process.exit(1);
                }
                // silently skip when showing all providers
            } else {
                // Credentials are stored as JSON: { token, projectId }
                let token: string;
                let projectId: string;
                try {
                    const parsed = JSON.parse(rawCred) as { token?: string; projectId?: string };
                    if (!parsed.token || !parsed.projectId) throw new Error("missing fields");
                    token = parsed.token;
                    projectId = parsed.projectId;
                } catch {
                    console.error("Gemini credentials are malformed. Use /login inside pizzapi to re-authenticate.");
                    process.exit(1);
                }

                // POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
                const CODE_ASSIST_ENDPOINT = process.env["CODE_ASSIST_ENDPOINT"] ?? "https://cloudcode-pa.googleapis.com";
                const CODE_ASSIST_API_VERSION = process.env["CODE_ASSIST_API_VERSION"] ?? "v1internal";
                const quotaUrl = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:retrieveUserQuota`;

                let quotaRes: Response;
                try {
                    quotaRes = await fetch(quotaUrl, {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ project: projectId }),
                    });
                } catch (err) {
                    const cause = err instanceof Error && (err as any).cause instanceof Error ? (err as any).cause.message : null;
                    const detail = cause ?? (err instanceof Error ? err.message : String(err));
                    console.error(`Failed to fetch Gemini usage: network error (${detail})`);
                    process.exit(1);
                }

                if (!quotaRes.ok) {
                    console.error(`Failed to fetch Gemini usage: HTTP ${quotaRes.status} ${quotaRes.statusText}`);
                    try {
                        const body = await quotaRes.text();
                        if (body) console.error(body);
                    } catch { /* ignore */ }
                    process.exit(1);
                }

                type BucketInfo = {
                    remainingAmount?: string;
                    remainingFraction?: number;
                    resetTime?: string;
                    tokenType?: string;
                    modelId?: string;
                };
                type GeminiQuotaResponse = { buckets?: BucketInfo[] };

                let quotaData: GeminiQuotaResponse;
                try {
                    quotaData = (await quotaRes.json()) as GeminiQuotaResponse;
                } catch (err) {
                    console.error(`Failed to parse Gemini usage response: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }

                if (showJson) {
                    console.log(JSON.stringify({ provider: "gemini", project: projectId, usage: quotaData }, null, 2));
                    printedAny = true;
                } else {
                    console.log("\nGemini usage (Google Cloud Code Assist, OAuth)");
                    console.log(`  Project: ${projectId}`);
                    console.log("─".repeat(58));

                    const buckets = quotaData.buckets ?? [];
                    if (buckets.length === 0) {
                        console.log("  No quota buckets returned.");
                    } else {
                        for (const bucket of buckets) {
                            const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "bucket";
                            const pct = bucket.remainingFraction != null
                                ? `${(bucket.remainingFraction * 100).toFixed(1)}% remaining`
                                : "";
                            const amt = bucket.remainingAmount != null ? ` (${bucket.remainingAmount} left)` : "";
                            const reset = bucket.resetTime ? `  resets ${new Date(bucket.resetTime).toLocaleString()}` : "";
                            console.log(`  ${label.padEnd(28)} ${pct}${amt}${reset}`);
                        }
                    }
                    printedAny = true;
                }
            }
        }

        if (!printedAny && !showJson) {
            console.log("\nNo usage data found. Log in with /login inside pizzapi to authenticate.");
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
        const { default: pkg } = await import("../package.json");
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

    // Load AGENTS.md from cwd (if present)
    const agentFiles: Array<{ path: string; content: string }> = [];
    const agentsMdPath = join(cwd, "AGENTS.md");
    if (existsSync(agentsMdPath)) {
        const content = await readFile(agentsMdPath, "utf-8");
        agentFiles.push({ path: agentsMdPath, content });
    }

    // Load .agents/*.md files from cwd
    const dotAgentsDir = join(cwd, ".agents");
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
        extensionFactories: [remoteExtension, mcpExtension, restartExtension, setSessionNameExtension, updateTodoExtension, spawnSessionExtension, getSessionStatusExtension, sessionMessagingExtension],
        additionalSkillPaths: buildSkillPaths(cwd, agentDir, config.skills),
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
