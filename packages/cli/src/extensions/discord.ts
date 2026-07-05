/**
 * Discord bridge extension — mirrors the pi session into a Discord thread.
 *
 * Pi-native by design: one ExtensionFactory, no relay hop, no custom trigger
 * types. Inbound Discord messages become `pi.sendUserMessage()` calls;
 * outbound assistant messages are posted from a `message_end` handler.
 *
 * Mapping: one session = one Discord thread under a configured parent
 * channel, named from the session name (renamed on `session_info_changed`).
 *
 * Config lives in ~/.pizzapi/config.json (global only — see config/io.ts):
 *   { "discord": { "token": "...", "channelId": "...", "allowedUserIds": [], "autoStart": false } }
 *
 * ponytail: single platform, no provider abstraction — extract a MessageProvider
 * interface when a second platform (Slack/Telegram) actually lands.
 */
import { basename } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import { loadConfig, type DiscordConfig } from "../config.js";
import { resolveInputDeliverAs } from "./remote/deliver-as-default.js";

const log = createLogger("discord");

/** Discord hard message limit. */
export const DISCORD_MAX_MESSAGE = 2000;

/** Discord thread name limit. */
const THREAD_NAME_MAX = 100;

/** Typing indicator expires after ~10s; refresh a little sooner. */
const TYPING_REFRESH_MS = 8000;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export interface ResolvedDiscordSettings {
    token: string;
    channelId: string;
    allowedUserIds: string[];
    autoStart: boolean;
}

/** Merge config-file settings with env overrides. Returns undefined unless token + channelId are present. */
export function resolveDiscordSettings(
    config: DiscordConfig | undefined,
    env: Record<string, string | undefined> = process.env,
): ResolvedDiscordSettings | undefined {
    const token = env.DISCORD_TOKEN?.trim() || config?.token?.trim();
    const channelId = env.DISCORD_CHANNEL_ID?.trim() || config?.channelId?.trim();
    if (!token || !channelId) return undefined;
    return {
        token,
        channelId,
        allowedUserIds: config?.allowedUserIds ?? [],
        autoStart: config?.autoStart === true,
    };
}

/** Empty allowlist = everyone who can post in the thread. */
export function isAllowedAuthor(authorId: string, allowedUserIds: string[]): boolean {
    return allowedUserIds.length === 0 || allowedUserIds.includes(authorId);
}

/** Split text into Discord-sized chunks, preferring newline boundaries. */
export function chunkDiscordMessage(text: string, max = DISCORD_MAX_MESSAGE): string[] {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf("\n", max);
        if (cut <= 0) cut = max;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
}

/** Extract the visible text from an assistant message (skips thinking/toolCall blocks). */
export function extractAssistantText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: string; text: string } => {
            return typeof b === "object" && b !== null && (b as any).type === "text" && typeof (b as any).text === "string";
        })
        .map((b) => b.text)
        .join("\n")
        .trim();
}

/** Build the initial thread name for a session. */
export function threadName(sessionName: string | undefined, cwd: string, date = new Date()): string {
    const base = sessionName?.trim() || basename(cwd) || "pi session";
    const stamp = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return `${base.slice(0, THREAD_NAME_MAX - stamp.length - 3)} · ${stamp}`;
}

// ── Bridge (discord.js, lazily imported) ─────────────────────────────────────

interface DiscordBridge {
    threadId: string;
    threadUrl: string;
    post(text: string): Promise<void>;
    rename(name: string): Promise<void>;
    /** Fire-and-forget typing indicator. */
    typing(): void;
    stop(): Promise<void>;
}

interface StartBridgeOptions {
    settings: ResolvedDiscordSettings;
    initialThreadName: string;
    onMessage(content: string): void;
}

async function startBridge({ settings, initialThreadName, onMessage }: StartBridgeOptions): Promise<DiscordBridge> {
    // Lazy import: unconfigured sessions never pay the discord.js load cost.
    const { Client, GatewayIntentBits } = await import("discord.js");

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    client.on("error", (err) => log.warn(`discord client error: ${err.message}`));

    await client.login(settings.token);

    const channel = await client.channels.fetch(settings.channelId);
    if (!channel || !("threads" in channel) || typeof (channel as any).threads?.create !== "function") {
        await client.destroy();
        throw new Error(`Channel ${settings.channelId} is not a text channel that supports threads`);
    }

    const thread = await (channel as any).threads.create({
        name: initialThreadName,
        autoArchiveDuration: 1440,
    });

    client.on("messageCreate", (msg: any) => {
        try {
            if (msg.channelId !== thread.id) return;
            if (msg.author?.bot) return;
            if (!isAllowedAuthor(String(msg.author?.id ?? ""), settings.allowedUserIds)) {
                log.warn(`discord: dropped message from unauthorized user ${msg.author?.id}`);
                return;
            }
            const content = String(msg.content ?? "").trim();
            if (content) onMessage(content);
        } catch (err) {
            log.warn(`discord inbound handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    return {
        threadId: thread.id,
        threadUrl: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
        async post(text: string) {
            for (const chunk of chunkDiscordMessage(text)) {
                await thread.send(chunk);
            }
        },
        async rename(name: string) {
            await thread.setName(name.slice(0, THREAD_NAME_MAX));
        },
        typing() {
            thread.sendTyping?.().catch(() => {});
        },
        async stop() {
            await client.destroy();
        },
    };
}

// ── Extension factory ────────────────────────────────────────────────────────

/** Stable module-level factory used by the standard PizzaPi roster. */
export const discordExtension: ExtensionFactory = (pi) => createDiscordExtension()(pi);

/**
 * @param loadDiscordConfig Lazy config loader — read at start/status time so
 * config edits are picked up without a restart. Injectable for tests.
 */
export function createDiscordExtension(
    loadDiscordConfig: () => DiscordConfig | undefined = () => loadConfig().discord,
): ExtensionFactory {
    return (pi) => {
        let bridge: DiscordBridge | undefined;
        let starting = false;
        let agentActive = false;
        let typingTimer: ReturnType<typeof setInterval> | undefined;

        const stopTyping = () => {
            if (typingTimer) clearInterval(typingTimer);
            typingTimer = undefined;
        };

        const stopBridge = async () => {
            stopTyping();
            const b = bridge;
            bridge = undefined;
            if (b) await b.stop().catch((err) => log.warn(`discord stop failed: ${err?.message ?? err}`));
        };

        const start = async (cwd: string): Promise<string> => {
            const settings = resolveDiscordSettings(loadDiscordConfig());
            if (!settings) {
                throw new Error(
                    'Discord is not configured. Add { "discord": { "token": "...", "channelId": "..." } } to ~/.pizzapi/config.json ' +
                        "(or set DISCORD_TOKEN and DISCORD_CHANNEL_ID).",
                );
            }
            if (bridge) return `Already connected (thread ${bridge.threadId})`;
            if (starting) return "Already connecting…";
            starting = true;
            try {
                bridge = await startBridge({
                    settings,
                    initialThreadName: threadName(pi.getSessionName(), cwd),
                    onMessage(content) {
                        const deliverAs = resolveInputDeliverAs(undefined, agentActive);
                        try {
                            pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
                        } catch (err) {
                            log.warn(`discord -> session inject failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                });
                return `Connected — thread ${bridge.threadUrl}`;
            } finally {
                starting = false;
            }
        };

        // ── Lifecycle ──
        pi.on("session_start", async (_event, ctx) => {
            agentActive = false;
            if (resolveDiscordSettings(loadDiscordConfig())?.autoStart && !bridge) {
                try {
                    const msg = await start(ctx.cwd);
                    log.info(`discord autoStart: ${msg}`);
                } catch (err) {
                    log.warn(`discord autoStart failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        });

        pi.on("session_shutdown", async () => {
            await stopBridge();
        });

        // ── Outbound: agent → Discord ──
        pi.on("agent_start", async () => {
            agentActive = true;
            if (!bridge) return;
            bridge.typing();
            stopTyping();
            typingTimer = setInterval(() => bridge?.typing(), TYPING_REFRESH_MS);
        });

        pi.on("agent_end", async () => {
            agentActive = false;
            stopTyping();
        });

        pi.on("message_end", async (event) => {
            if (!bridge || event.message.role !== "assistant") return;
            const text = extractAssistantText((event.message as any).content);
            if (!text) return; // pure tool-call turns
            await bridge.post(text).catch((err) => log.warn(`discord post failed: ${err?.message ?? err}`));
        });

        pi.on("session_info_changed", async (event) => {
            if (!bridge || !event.name) return;
            await bridge.rename(event.name).catch((err) => log.warn(`discord rename failed: ${err?.message ?? err}`));
        });

        // ── Command ──
        pi.registerCommand("discord", {
            description: "Discord bridge: start | stop | status",
            getArgumentCompletions: (prefix: string) => {
                const items = ["start", "stop", "status"]
                    .filter((s) => s.startsWith(prefix))
                    .map((s) => ({ value: s, label: s }));
                return items.length > 0 ? items : null;
            },
            handler: async (args, ctx) => {
                const sub = args?.trim() || "status";
                try {
                    if (sub === "start") {
                        ctx.ui.notify(await start(ctx.cwd), "info");
                    } else if (sub === "stop") {
                        await stopBridge();
                        ctx.ui.notify("Discord bridge stopped", "info");
                    } else if (sub === "status") {
                        ctx.ui.notify(
                            bridge
                                ? `Connected — thread ${bridge.threadUrl}`
                                : resolveDiscordSettings(loadDiscordConfig())
                                  ? "Configured but not connected (/discord start)"
                                  : "Not configured (~/.pizzapi/config.json → discord)",
                            "info",
                        );
                    } else {
                        ctx.ui.notify(`Unknown subcommand "${sub}" — use start | stop | status`, "warning");
                    }
                } catch (err) {
                    ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
                }
            },
        });
    };
}
