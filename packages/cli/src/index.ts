#!/usr/bin/env bun
import {
    createAgentSession,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    DefaultResourceLoader,
    InteractiveMode,
    readStoredCredential,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { join } from "path";
import { maybeBuildSystemPrompt, defaultAgentDir, expandHome, loadConfig, resolveSandboxConfig, validateSandboxOverride, applyProviderSettingsEnv, resolveExplicitProjectTrust } from "./config.js";
import { isPackageCommand, runPackageCommand } from "./package-commands.js";
import { getOAuthAccessToken, getAnthropicKeychainToken } from "./runner/usage-auth.js";
import { c, usageBar, colorPct } from "./cli-colors.js";
import { buildSkillPaths, buildPromptTemplatePaths, createAgentsFilesOverride } from "./skills.js";
import { getPluginSkillPaths, getPluginPromptTemplatePaths } from "./extensions/claude-plugins.js";
import { buildPizzaPiExtensionFactories } from "./extensions/factories.js";
import { setRemoteSessionHost } from "./extensions/remote/session-host-ref.js";
import { runtimeSessionHost } from "./runner/session-host.js";
import { migrateAgentDir } from "./migrations.js";
import { runSetup } from "./setup.js";
import { expandFileBackedEnv } from "./secrets.js";
import { createLogger, initSandbox, cleanupSandbox, isSandboxActive } from "@pizzapi/tools";

const log = createLogger("cli");

// ponytail: standalone binaries can't resolve pi-ai's dynamic OAuth imports; register the statically bundled flows.
registerBunOAuthFlows();

async function main() {
    // Docker/K8s secrets are file-based — populate FOO from FOO_FILE for
    // credential-shaped env vars before anything reads them.
    expandFileBackedEnv();

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
    if (args[0] === "runner" && args[1] === "install") {
        const { runInstall } = await import("./runner/install.js");
        process.exit(runInstall(args.slice(2)));
    }

    if (args[0] === "runner" && args[1] === "stop") {
        const { runStop } = await import("./runner/stop.js");
        const code = await runStop();
        process.exit(code);
    }

    if (args[0] === "runner" && args[1] === "status") {
        const { runStatus } = await import("./runner/status.js");
        const code = await runStatus(args.slice(2));
        process.exit(code);
    }

    if (args[0] === "runner" && args[1] === "pair") {
        const { runPair } = await import("./runner/pair.js");
        const code = await runPair(args.slice(2));
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
    // `_worker` → internal entrypoint used by the daemon to spawn session workers
    //   inside compiled binaries. Not intended to be called directly.
    if (args[0] === "_worker") {
        await import("./runner/worker.js");
        return;
    }

    // `_terminal-worker` → internal entrypoint for terminal PTY workers
    //   inside compiled binaries. Not intended to be called directly.
    if (args[0] === "_terminal-worker") {
        await import("./runner/terminal-worker.js");
        return;
    }

    if (args[0] === "_daemon") {
        const { runDaemon } = await import("./runner/daemon.js");
        const code = await runDaemon(args.slice(1));
        process.exit(code);
    }

    if (args[0] === "web") {
        const { runWeb } = await import("./web.js");
        await runWeb(args.slice(1));
        return;
    }

    if (args[0] === "local") {
        const { runLocal } = await import("./local.js");
        await runLocal(args.slice(1));
        return;
    }

    if (args[0] === "setup") {
        await runSetup({ force: true, scan: args.includes("--scan") });
        return;
    }

    if (args[0] === "usage") {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        const authPath = join(agentDir, "auth.json");
        const showJson = args.includes("--json");

        // Determine which provider(s) to show
        const providerArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const showAnthropic = !providerArg || providerArg === "anthropic";
        const showGemini = !providerArg || providerArg === "gemini";

        let printedAny = false;

        // ── Anthropic ──────────────────────────────────────────────────────────
        if (showAnthropic) {
            // auth.json first, then fall back to Claude Code's own OAuth token
            // (Keychain / ~/.claude/.credentials.json) for users who never ran
            // /login inside pizzapi — read-only, never refreshed.
            const accessToken = getOAuthAccessToken(readStoredCredential("anthropic", authPath)) ?? getAnthropicKeychainToken();
            if (!accessToken) {
                if (providerArg === "anthropic") {
                    log.error("No Anthropic credentials found. Log in with /login inside pizzapi.");
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
                    log.error(`Failed to fetch Anthropic usage: network error (${detail})`);
                    process.exit(1);
                }

                if (!res.ok) {
                    log.error(`Failed to fetch Anthropic usage: HTTP ${res.status} ${res.statusText}`);
                    try {
                        const body = await res.text();
                        if (body) log.error(body);
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
                    log.error(`Failed to parse Anthropic usage response: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }

                if (showJson) {
                    log.info(JSON.stringify({ provider: "anthropic", usage }, null, 2));
                    printedAny = true;
                } else {
                    const formatWindow = (label: string, w: UsageWindow) => {
                        if (!w) return;
                        const bar = usageBar(w.utilization);
                        const reset = new Date(w.resets_at).toLocaleString();
                        log.info(`  ${label.padEnd(22)} ${bar}  ${c.dim(`resets ${reset}`)}`);
                    };

                    log.info("");
                    log.info(c.label("Claude usage") + c.dim(" (OAuth subscription)"));
                    log.info(c.dim("─".repeat(58)));
                    formatWindow("5-hour window", usage.five_hour);
                    formatWindow("7-day window", usage.seven_day);
                    formatWindow("7-day (OAuth apps)", usage.seven_day_oauth_apps);
                    formatWindow("7-day (Opus)", usage.seven_day_opus);
                    formatWindow("7-day (Sonnet)", usage.seven_day_sonnet);
                    formatWindow("7-day (co-work)", usage.seven_day_cowork);

                    const ex = usage.extra_usage;
                    if (ex?.is_enabled) {
                        log.info("");
                        log.info(`  ${c.accent("Extra usage enabled")}`);
                        if (ex.monthly_limit != null) log.info(`    Monthly limit:   ${c.bold(`$${ex.monthly_limit}`)}`);
                        if (ex.used_credits != null) log.info(`    Credits used:    ${c.bold(`$${ex.used_credits}`)}`);
                        if (ex.utilization != null) log.info(`    Utilization:     ${colorPct(ex.utilization)}`);
                    }
                    printedAny = true;
                }
            }
        }

        // ── Gemini (Google Cloud Code Assist, OAuth) ───────────────────────────
        if (showGemini) {
            const geminiCred = readStoredCredential("google-gemini-cli", authPath);
            const rawCred = geminiCred?.type === "api_key" ? geminiCred.key : undefined;
            if (!rawCred) {
                if (providerArg === "gemini") {
                    log.error("No Gemini credentials found. Log in with /login inside pizzapi.");
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
                    log.error("Gemini credentials are malformed. Use /login inside pizzapi to re-authenticate.");
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
                    log.error(`Failed to fetch Gemini usage: network error (${detail})`);
                    process.exit(1);
                }

                if (!quotaRes.ok) {
                    log.error(`Failed to fetch Gemini usage: HTTP ${quotaRes.status} ${quotaRes.statusText}`);
                    try {
                        const body = await quotaRes.text();
                        if (body) log.error(body);
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
                    log.error(`Failed to parse Gemini usage response: ${err instanceof Error ? err.message : String(err)}`);
                    process.exit(1);
                }

                if (showJson) {
                    log.info(JSON.stringify({ provider: "gemini", project: projectId, usage: quotaData }, null, 2));
                    printedAny = true;
                } else {
                    log.info("");
                    log.info(c.label("Gemini usage") + c.dim(" (Google Cloud Code Assist, OAuth)"));
                    log.info(`  ${c.dim("Project:")} ${projectId}`);
                    log.info(c.dim("─".repeat(58)));

                    const buckets = quotaData.buckets ?? [];
                    if (buckets.length === 0) {
                        log.info("  No quota buckets returned.");
                    } else {
                        for (const bucket of buckets) {
                            const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "bucket";
                            // remainingFraction is 0–1 (remaining), so used = 1 - remaining
                            const usedPct = bucket.remainingFraction != null
                                ? (1 - bucket.remainingFraction) * 100
                                : null;
                            const bar = usedPct !== null ? usageBar(usedPct) : "";
                            const usedStr = usedPct !== null
                                ? ` ${colorPct(usedPct)} used`
                                : "";
                            const amt = bucket.remainingAmount != null ? c.dim(` (${bucket.remainingAmount} left)`) : "";
                            const reset = bucket.resetTime ? c.dim(`  resets ${new Date(bucket.resetTime).toLocaleString()}`) : "";
                            log.info(`  ${label.padEnd(28)} ${bar}${usedStr}${amt}${reset}`);
                        }
                    }
                    printedAny = true;
                }
            }
        }

        if (!printedAny && !showJson) {
            log.info("\nNo usage data found. Log in with /login inside pizzapi to authenticate.");
        }
        log.info("");
        return;
    }

    if (args[0] === "plugins") {
        const { runPluginsCommand } = await import("./plugins-cli.js");
        await runPluginsCommand(args.slice(1), cwd);
        return;
    }

    if (args[0] === "models") {
        const { runModelsCommand } = await import("./models-command.js");
        const code = await runModelsCommand(args.slice(1), cwd);
        process.exit(code);
    }

    if (args[0] === "auth") {
        const { runAuthCommand } = await import("./auth-command.js");
        const code = await runAuthCommand(args.slice(1), cwd);
        process.exit(code);
    }

    if (args[0] === "config" && args[1] === "show") {
        const { runConfigShowCommand } = await import("./config-show.js");
        process.exit(runConfigShowCommand(cwd));
    }

    if (isPackageCommand(args[0])) {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        const code = await runPackageCommand(args, cwd, agentDir);
        process.exit(code);
    }

    if (args.includes("--version") || args.includes("-v")) {
        const { default: pkg } = await import("../package.json");
        log.info(`pizzapi v${pkg.version}`);
        return;
    }

    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
        const { default: pkg } = await import("../package.json");
        const ver = c.dim(`v${pkg.version}`);
        log.info("");
        log.info(`${c.brand("🍕 PizzaPi")} ${ver}`);
        log.info("");
        log.info(c.label("Commands"));
        log.info(`  ${c.cmd("pizza")}                       Start an interactive agent session`);
        log.info(`  ${c.cmd("pizza local")} ${c.dim("[flags]")}         Start local relay + runner in one command`);
        log.info(`  ${c.cmd("pizza web")} ${c.dim("[flags]")}           Manage the PizzaPi web hub (Docker)`);
        log.info(`  ${c.cmd("pizza runner")} ${c.dim("[args]")}         Manage the background runner daemon`);
        log.info(`  ${c.cmd("pizza runner install")} [--activate] [--dry-run]  Install a persistent runner service`);
        log.info(`  ${c.cmd("pizza runner stop")}           Stop the runner daemon`);
        log.info(`  ${c.cmd("pizza runner status")} ${c.dim("[--json]")}  Health check the runner daemon (exit 0 = healthy)`);
        log.info(`  ${c.cmd("pizza runner pair")} ${c.dim("[--force]")}   Pair (or re-pair) the runner with a fresh API key`);
        log.info(`  ${c.cmd("pizza setup")}                 Run first-time setup`);
        log.info(`  ${c.cmd("pizza usage")} ${c.dim("[provider]")}      Show API usage stats`);
        log.info(`  ${c.cmd("pizza models")}                List available models`);
        log.info(`  ${c.cmd("pizza auth")} ${c.dim("[provider]")}       Log in to a model provider (headless-friendly)`);
        log.info(`  ${c.cmd("pizza plugins")} ${c.dim("[cmd]")}         Manage Claude Code plugins`);
        log.info(`  ${c.cmd("pizza install")} ${c.dim("<source>")}       Install a pi package (extensions, skills, prompts, themes)`);
        log.info(`  ${c.cmd("pizza remove")} ${c.dim("<source>")}        Remove an installed pi package`);
        log.info(`  ${c.cmd("pizza update")} ${c.dim("[source|self]")}   Update installed pi packages`);
        log.info(`  ${c.cmd("pizza list")}                    List installed pi packages`);
        log.info(`  ${c.cmd("pizza config")}                  Enable/disable package resources`);
        log.info(`  ${c.cmd("pizza config show")}             Print resolved effective config (secrets redacted)`);
        log.info("");
        log.info(c.label("Flags"));
        log.info(`  ${c.flag("--cwd")} ${c.dim("<path>")}         Set working directory`);
        log.info(`  ${c.flag("--sandbox")} ${c.dim("<mode>")}      Set sandbox mode: ${c.dim("enforce, audit, or off")}`);
        log.info(`  ${c.flag("--safe-mode")}            Skip MCP, plugins, hooks, and relay`);
        log.info(`  ${c.flag("--no-mcp")}               Skip MCP server connections`);
        log.info(`  ${c.flag("--no-plugins")}           Skip Claude Code plugin loading`);
        log.info(`  ${c.flag("--no-hooks")}             Skip hook execution`);
        log.info(`  ${c.flag("--no-relay")}             Skip relay server connection`);
        log.info(`  ${c.flag("-v, --version")}          Show version`);
        log.info(`  ${c.flag("-h, --help")}             Show this help`);
        log.info("");
        log.info(c.dim(`Run pizza <command> --help for command-specific help.`));
        log.info("");
        return;
    }

    // ── Safe-mode flags ──────────────────────────────────────────────────────
    // Support both CLI flags and PIZZAPI_NO_* env vars (same as worker mode).
    const safeMode = args.includes("--safe-mode");
    const noMcp = safeMode || args.includes("--no-mcp") || process.env.PIZZAPI_NO_MCP === "1";
    const noPlugins = safeMode || args.includes("--no-plugins") || process.env.PIZZAPI_NO_PLUGINS === "1";
    const noHooks = safeMode || args.includes("--no-hooks") || process.env.PIZZAPI_NO_HOOKS === "1";
    const noRelay = safeMode || args.includes("--no-relay") || process.env.PIZZAPI_NO_RELAY === "1";

    // ── Sandbox flag ─────────────────────────────────────────────────────────
    // Parse --sandbox=<mode> or --sandbox <mode> from CLI args.
    // Also support PIZZAPI_NO_SANDBOX=1 as shorthand for --sandbox=off.
    let sandboxFlagValue: string | undefined;
    const sandboxEqIdx = args.findIndex((a) => a.startsWith("--sandbox="));
    if (sandboxEqIdx !== -1) {
        sandboxFlagValue = args[sandboxEqIdx].split("=")[1];
        args.splice(sandboxEqIdx, 1);
    } else {
        const sandboxIdx = args.indexOf("--sandbox");
        if (sandboxIdx !== -1 && args[sandboxIdx + 1] && !args[sandboxIdx + 1].startsWith("--")) {
            sandboxFlagValue = args[sandboxIdx + 1];
            args.splice(sandboxIdx, 2);
        }
    }

    if (sandboxFlagValue) {
        process.env.PIZZAPI_SANDBOX = sandboxFlagValue;
    } else if (process.env.PIZZAPI_NO_SANDBOX === "1") {
        process.env.PIZZAPI_SANDBOX = "off";
    }

    // Strip safe-mode flags so pi doesn't see them
    for (const flag of ["--safe-mode", "--no-mcp", "--no-plugins", "--no-hooks", "--no-relay"]) {
        const idx = args.indexOf(flag);
        if (idx !== -1) args.splice(idx, 1);
    }

    // Migrate legacy agent data into flat ~/.pizzapi/ before anything reads from it
    migrateAgentDir();

    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();

    // ── Provider settings → env vars ───────────────────────────────────────
    applyProviderSettingsEnv(config);

    // First-run: no API key configured — prompt setup before launching TUI
    const hasApiKey = !!(process.env.PIZZAPI_API_KEY ?? config.apiKey);
    const relayDisabled = noRelay || (process.env.PIZZAPI_RELAY_URL ?? config.relayUrl ?? "").toLowerCase() === "off";
    if (!hasApiKey && !relayDisabled) {
        await runSetup();
    }

    if (safeMode) {
        if (process.stdout.isTTY) {
            log.info(
                "\n\x1b[33m⚡ Safe mode\x1b[0m\x1b[2m — \x1b[0m" +
                "\x1b[31mMCP servers\x1b[0m\x1b[2m, \x1b[0m" +
                "\x1b[31mplugins\x1b[0m\x1b[2m, \x1b[0m" +
                "\x1b[31mhooks\x1b[0m\x1b[2m, and \x1b[0m" +
                "\x1b[31mrelay\x1b[0m\x1b[2m are disabled.\x1b[0m\n",
            );
        } else {
            log.info("\n⚡ Safe mode — MCP servers, plugins, hooks, and relay are disabled.\n");
        }
    }

    // ── Sandbox initialization ─────────────────────────────────────────────
    const sandboxConfig = resolveSandboxConfig(cwd, config);
    // PIZZAPI_SANDBOX env var / --sandbox flag can override the configured mode.
    // validateSandboxOverride() resolves aliases (enforce→full, audit→basic, off→none)
    // and throws on unrecognised values so operators get a clear error.
    const sandboxOverride = validateSandboxOverride(process.env.PIZZAPI_SANDBOX);
    if (sandboxOverride === "none") {
        sandboxConfig.mode = "none";
        sandboxConfig.srtConfig = null;
    } else if (sandboxOverride === "basic" || sandboxOverride === "full") {
        // Re-resolve so srtConfig matches the overridden preset, not just the mode string.
        const overrideConfig = { ...config, sandbox: { ...(config.sandbox), mode: sandboxOverride } };
        const overridden = resolveSandboxConfig(cwd, overrideConfig);
        sandboxConfig.mode = overridden.mode;
        sandboxConfig.srtConfig = overridden.srtConfig;
    }

    try {
        await initSandbox(sandboxConfig);
    } catch (err) {
        log.warn(
            `pizzapi: sandbox init failed, continuing unsandboxed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (isSandboxActive()) {
        process.env.PIZZAPI_SANDBOX_ACTIVE = "1";
        process.env.PIZZAPI_SANDBOX_MODE = sandboxConfig.mode;
    } else if (sandboxConfig.mode !== "none") {
        log.warn("pizzapi: sandbox was requested but is not active (platform unsupported or init failed)");
    }

    // Build shared agentsFilesOverride (loads AGENTS.md + .agents/*.md from cwd,
    // deduplicating against what DefaultResourceLoader already discovers).
    const agentsFilesOverride = createAgentsFilesOverride(cwd, {
        sendAgentsMd: config.sendAgentsMd !== false,
    });

    // Override relay URL if --no-relay was passed
    if (noRelay) {
        process.env.PIZZAPI_RELAY_URL = "off";
    }

    // Explicit, persisted pi project-trust decision for the initial cwd — the
    // single authority gating native pi project resources (extensions/
    // skills/prompts) AND the session-side pi.pizzapi overlay (agents/rules/
    // mcp from project-scope configured packages). Fails closed: an
    // undecided or explicitly-untrusted repo never auto-executes project
    // package code. No new trust UI here — pi's own persisted trust.json is
    // the authority (see config/io.ts resolveExplicitProjectTrust).
    const projectTrusted = resolveExplicitProjectTrust(cwd, agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });

    // Build extension list — includes configured hooks when present.
    const extensionFactories = buildPizzaPiExtensionFactories({
        cwd,
        agentDir,
        hooks: noHooks ? undefined : config.hooks,
        skipMcp: noMcp,
        skipPlugins: noPlugins,
        skipRelay: noRelay,
        configSkills: config.skills,
        projectTrusted,
    });

    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories,
        additionalSkillPaths: [
            ...buildSkillPaths(cwd, config.skills),
            ...(noPlugins ? [] : getPluginSkillPaths(cwd)),
        ],
        additionalPromptTemplatePaths: [
            ...buildPromptTemplatePaths(cwd),
            ...(noPlugins ? [] : getPluginPromptTemplatePaths(cwd)),
        ],
        ...(config.systemPrompt !== undefined
            ? { systemPromptOverride: () => config.systemPrompt }
            : {}
        ),
        appendSystemPrompt: (() => {
            const parts = [maybeBuildSystemPrompt(config, { cwd }), config.appendSystemPrompt].filter(Boolean) as string[];
            return parts;
        })(),
        ...(agentsFilesOverride && { agentsFilesOverride }),
    });
    await loader.reload();

    const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));

    const createRuntime = async (opts: { cwd: string; agentDir: string; sessionManager: SessionManager }) => {
        // Re-resolve trust explicitly for THIS cwd/agentDir — createRuntime is
        // reused across /new, /resume, /fork, and session switches, which can
        // target a different cwd than the process started in, and pi's own
        // trust.json can change between calls (e.g. the user trusts the repo
        // via pi's own flow mid-process).
        const rtProjectTrusted = resolveExplicitProjectTrust(opts.cwd, opts.agentDir);
        const rtSettingsManager = SettingsManager.create(opts.cwd, opts.agentDir, { projectTrusted: rtProjectTrusted });
        const rtAgentsFilesOverride = createAgentsFilesOverride(opts.cwd, {
            sendAgentsMd: config.sendAgentsMd !== false,
        });
        const services = await createAgentSessionServices({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            settingsManager: rtSettingsManager,
            resourceLoaderOptions: {
                extensionFactories: extensionFactories as any,
                additionalSkillPaths: [
                    ...buildSkillPaths(opts.cwd, config.skills),
                    ...(noPlugins ? [] : getPluginSkillPaths(opts.cwd)),
                ],
                additionalPromptTemplatePaths: [
                    ...buildPromptTemplatePaths(opts.cwd),
                    ...(noPlugins ? [] : getPluginPromptTemplatePaths(opts.cwd)),
                ],
                ...(config.systemPrompt !== undefined && {
                    systemPromptOverride: () => config.systemPrompt,
                }),
                appendSystemPrompt: [maybeBuildSystemPrompt(config, { cwd: opts.cwd }), config.appendSystemPrompt].filter(Boolean) as string[],
                ...(rtAgentsFilesOverride && { agentsFilesOverride: rtAgentsFilesOverride }),
            },
        });
        const result = await createAgentSessionFromServices({
            services,
            sessionManager: opts.sessionManager,
        });
        return { ...result, services, diagnostics: [] as any[] };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager,
    });

    // Install the TUI-backed SessionHost so the remote extension can drive
    // new/switch/fork + queue ops through `runtime` instead of the removed
    // patched ExtensionAPI surface (mirrors worker.ts's SessionHost wiring).
    setRemoteSessionHost(
        runtimeSessionHost(runtime, (followUp) => {
            const { steering } = runtime.session.clearQueue();
            for (const text of steering) void (runtime.session as any)._queueSteer(text);
            for (const text of followUp) void (runtime.session as any)._queueFollowUp(text);
        }),
    );

    const mode = new InteractiveMode(runtime, {
        modelFallbackMessage: runtime.modelFallbackMessage,
    });
    try {
        await mode.run();
    } finally {
        try {
            await cleanupSandbox();
        } catch {}
    }
}

main().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
