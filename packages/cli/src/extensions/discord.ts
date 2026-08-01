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
import { buildSkillPaths, scanSkillsDir } from "../skills.js";
import { resolveInputDeliverAs } from "./remote/deliver-as-default.js";

interface SkillMeta {
    name: string;
    description: string;
    commandId?: string;
    parameters?: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'choice';
        description?: string;
        required?: boolean;
        choices?: string[];
    }>;
}

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
    postEmbed(title: string, fields: Array<{ name: string; value: string; inline?: boolean }>, color?: number): Promise<string>;
    editEmbed(messageId: string, title: string, fields: Array<{ name: string; value: string; inline?: boolean }>, color?: number): Promise<void>;
    postArtifact(name: string, data: Buffer, mimeType: string): Promise<void>;
    rename(name: string): Promise<void>;
    /** Fire-and-forget typing indicator. */
    typing(): void;
    stop(): Promise<void>;
}


// ── Message tracking for real-time updates ────────────────────────────────────

interface MessageTracker {
    messageId: string;
    timestamp: number;
    type: 'tool-call' | 'progress' | 'artifact';
    toolName?: string;
}


interface StartBridgeOptions {
    settings: ResolvedDiscordSettings;
    initialThreadName: string;
    cwd: string;
    onMessage(content: string): void;
    onToolCall(name: string, args: unknown): void;
    onToolResult(result: unknown): void;
    onArtifact(type: string, data: unknown): void;
    onMessageStart(): void;
    onAgentStart(): void;
    onAgentEnd(): void;
}


// ── Skill parameter extraction from frontmatter ────────────────────────────────────

/**
 * Extract parameters from skill frontmatter (YAML format).
 * Expected structure:
 *   ---
 *   description: "..."
 *   parameters:
 *     - name: "param1"
 *       type: "string"
 *       description: "..."
 *       required: true
 *       choices: ["a", "b"]
 *   ---
 */
function parseSkillParameters(content: string): Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'choice';
    description?: string;
    required?: boolean;
    choices?: string[];
}> {
    if (!content.startsWith("---")) return [];
    const end = content.indexOf("\n---", 3);
    if (end === -1) return [];

    const block = content.slice(3, end);
    
    // Simple YAML-like parsing for parameters
    const paramMatch = block.match(/^parameters:\s*$/m);
    if (!paramMatch) return [];
    
    const paramSection = block.slice(paramMatch.index! + paramMatch[0].length);
    const lines = paramSection.split('\n').filter(l => l.trim());
    
    const params: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'choice';
        description?: string;
        required?: boolean;
        choices?: string[];
    }> = [];
    
    let currentParam: any = null;
    
    for (const line of lines) {
        if (line.startsWith('  - name:')) {
            if (currentParam) params.push(currentParam);
            currentParam = { name: line.split(':')[1].trim().replace(/^["']|["']$/g, ''), type: 'string' };
        } else if (line.startsWith('    type:')) {
            if (currentParam) currentParam.type = line.split(':')[1].trim().replace(/^["']|["']$/g, '');
        } else if (line.startsWith('    description:')) {
            if (currentParam) currentParam.description = line.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '');
        } else if (line.startsWith('    required:')) {
            if (currentParam) currentParam.required = line.includes('true');
        } else if (line.startsWith('    choices:')) {
            if (currentParam) {
                const choiceStr = line.split(':')[1].trim();
                try {
                    currentParam.choices = JSON.parse(choiceStr);
                } catch { }
            }
        }
    }
    if (currentParam) params.push(currentParam);
    
    return params;
}


async function startBridge({ settings, initialThreadName, cwd, onMessage, onToolCall, onToolResult, onArtifact, onMessageStart, onAgentStart, onAgentEnd }: StartBridgeOptions): Promise<DiscordBridge> {
    // Lazy import: unconfigured sessions never pay the discord.js load cost.
    const { Client, GatewayIntentBits } = await import("discord.js");

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    client.on("error", (err: any) => log.warn(`discord client error: ${err.message}`));

    const skills: SkillMeta[] = [];

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

    // ── Skill enumeration & slash command registration ──
    const { readFileSync } = await import('node:fs');
    const skillPaths = buildSkillPaths(cwd);
    for (const skillPath of skillPaths) {
        const skillsInDir = scanSkillsDir(skillPath);
        for (const skillMeta of skillsInDir) {
            if (skills.find(s => s.name === skillMeta.name)) continue;
            
            // Extract parameters from skill file
            let parameters = undefined;
            try {
                const skillContent = readFileSync(skillMeta.filePath, 'utf-8');
                parameters = parseSkillParameters(skillContent);
            } catch (err) {
                log.info(`failed to parse skill parameters for ${skillMeta.name}: ${err}`);
            }
            
            skills.push({ name: skillMeta.name, description: skillMeta.description, parameters });
        }
    }

    if (client.application) {
        for (const skill of skills) {
            try {
                const options: any[] = [];
                
                // Build options from parameters if available, else fallback to args
                if (skill.parameters && skill.parameters.length > 0) {
                    for (const param of skill.parameters) {
                        const typeMap: Record<string, number> = {
                            string: 3, number: 4, boolean: 5, choice: 3
                        };
                        const option: any = {
                            name: param.name,
                            description: param.description || param.name,
                            type: typeMap[param.type] ?? 3,
                            required: param.required ?? false,
                        };
                        if (param.choices && param.choices.length > 0) {
                            option.choices = param.choices.map(c => ({ name: c, value: c }));
                        }
                        options.push(option);
                    }
                } else {
                    // Fallback: free-form args if no parameters defined
                    options.push({ name: 'args', description: 'Arguments for the skill', type: 3, required: false });
                }
                
                const cmd = await client.application.commands.create({
                    name: skill.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
                    description: skill.description || `Run ${skill.name}`,
                    options,
                });
                skill.commandId = cmd.id;
            } catch (err) {
                log.warn(`failed to register slash command for skill ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

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

    client.on("interactionCreate", async (interaction: any) => {
        try {
            if (!interaction.isCommand?.()) return;
            const skill = skills.find(s => s.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-') === interaction.commandName);
            if (!skill) return;
            await interaction.deferReply?.();
            
            // Build skill invocation from typed parameters or fallback to args
            let cmdStr = `/run-skill ${skill.name}`;
            
            if (skill.parameters && skill.parameters.length > 0) {
                // Typed parameters: collect from individual options
                const args: string[] = [];
                for (const param of skill.parameters) {
                    const value = interaction.options?.getString?.(param.name) ||
                                 interaction.options?.getNumber?.(param.name) ||
                                 interaction.options?.getBoolean?.(param.name);
                    if (value !== undefined && value !== null) {
                        args.push(`--${param.name} ${JSON.stringify(value)}`);
                    }
                }
                if (args.length > 0) cmdStr += ` ${args.join(' ')}`;
            } else {
                // Fallback: free-form args
                const args = interaction.options?.getString?.('args')?.trim() || '';
                if (args) cmdStr += ` ${args}`;
            }
            
            onMessage(cmdStr);
        } catch (err) {
            log.warn(`discord interactionCreate handler failed: ${err instanceof Error ? err.message : String(err)}`);
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
        async postEmbed(title: string, fields: Array<{ name: string; value: string; inline?: boolean }>, color?: number) {
            const { EmbedBuilder } = await import("discord.js");
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setColor(color ?? 0x5865F2)
                .setTimestamp();
            for (const field of fields) {
                embed.addFields({ name: field.name, value: field.value, inline: field.inline ?? false });
            }
            const msg = await thread.send({ embeds: [embed] });
            return msg.id;
        },
        async editEmbed(messageId: string, title: string, fields: Array<{ name: string; value: string; inline?: boolean }>, color?: number) {
            try {
                const { EmbedBuilder } = await import("discord.js");
                const msg = await thread.messages.fetch(messageId);
                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setColor(color ?? 0x5865F2)
                    .setTimestamp();
                for (const field of fields) {
                    embed.addFields({ name: field.name, value: field.value, inline: field.inline ?? false });
                }
                await msg.edit({ embeds: [embed] });
            } catch (err) {
                log.warn(`failed to edit embed ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        async postArtifact(name: string, data: Buffer, mimeType: string) {
            try {
                const { AttachmentBuilder } = await import("discord.js");
                const attachment = new AttachmentBuilder(data, { name });
                await thread.send({ content: `📎 **${name}** (${mimeType})`, files: [attachment] });
            } catch (err) {
                log.warn(`failed to post artifact ${name}: ${err instanceof Error ? err.message : String(err)}`);
            }
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
                    cwd,
                    onMessage(content) {
                        const deliverAs = resolveInputDeliverAs(undefined, agentActive);
                        try {
                            pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
                        } catch (err) {
                            log.warn(`discord -> session inject failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onToolCall(name, args) {
                        try {
                            const argsStr = JSON.stringify(args, null, 2).slice(0, 1000);
                            bridge?.postEmbed(`🔧 Tool Call: ${name}`, [
                                { name: 'Arguments', value: `\`\`\`json\n${argsStr}\n\`\`\`` },
                                { name: 'Status', value: 'Executing...' },
                            ], 0xFFA500).then(msgId => {
                                // Store message ID for later editing with results
                                (bridge as any)._lastToolMessageId = msgId;
                            }).catch(err => log.warn(`discord postEmbed failed: ${err?.message ?? err}`));
                        } catch (err) {
                            log.warn(`discord onToolCall handler failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onToolResult(result) {
                        try {
                            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                            const chunks = chunkDiscordMessage(resultStr, 1024);
                            const firstChunk = chunks[0] || '';
                            
                            // Edit the tool call message with result (if we have the ID)
                            const msgId = (bridge as any)._lastToolMessageId;
                            if (msgId) {
                                bridge?.editEmbed(msgId, `✅ Tool Completed`, [
                                    { name: 'Result', value: `\`\`\`\n${firstChunk}\n\`\`\`` },
                                ], 0x57F287).catch(err => log.warn(`discord editEmbed failed: ${err?.message ?? err}`));
                                (bridge as any)._lastToolMessageId = undefined;
                                
                                // Post additional chunks if result was large
                                for (let i = 1; i < chunks.length; i++) {
                                    bridge?.post(`\`\`\`\n${chunks[i]}\n\`\`\``).catch(err => log.warn(`discord post failed: ${err?.message ?? err}`));
                                }
                            }
                        } catch (err) {
                            log.warn(`discord onToolResult handler failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onArtifact(type, data: any) {
                        try {
                            // Handle image artifacts
                            if (type === 'image' && data) {
                                let buffer: Buffer | undefined;
                                let mimeType = 'image/png';
                                let filename = 'artifact.png';
                                
                                // Extract buffer from various formats
                                if (data instanceof Buffer) {
                                    buffer = data;
                                } else if (typeof data === 'string') {
                                    // Could be base64 or data URL
                                    let base64 = data;
                                    if (data.startsWith('data:')) {
                                        const match = data.match(/^data:([^;]+);base64,(.+)$/);
                                        if (match) {
                                            mimeType = match[1];
                                            base64 = match[2];
                                            filename = `artifact.${mimeType.split('/')[1] || 'png'}`;
                                        }
                                    }
                                    buffer = Buffer.from(base64, 'base64');
                                } else if (typeof data === 'object' && data.data instanceof Uint8Array) {
                                    buffer = Buffer.from(data.data);
                                    if (data.mimeType) mimeType = data.mimeType;
                                    if (data.filename) filename = data.filename;
                                }
                                
                                if (buffer) {
                                    bridge?.postArtifact(filename, buffer, mimeType)
                                        .catch(err => log.warn(`discord postArtifact failed: ${err?.message ?? err}`));
                                }
                            } else {
                                log.info(`discord: artifact type ${type} not yet supported`);
                            }
                        } catch (err) {
                            log.warn(`discord onArtifact handler failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onMessageStart() {
                        try {
                            bridge?.postEmbed(`💭 Agent Thinking`, [{ name: 'Status', value: 'Processing...' }], 0x5865F2)
                                .catch(err => log.warn(`discord postEmbed failed: ${err?.message ?? err}`));
                        } catch (err) {
                            log.warn(`discord onMessageStart handler failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onAgentStart() {
                        try {
                            bridge?.postEmbed(`🤖 Agent Started`, [{ name: 'Status', value: 'Running...' }], 0x5865F2)
                                .catch(err => log.warn(`discord postEmbed failed: ${err?.message ?? err}`));
                        } catch (err) {
                            log.warn(`discord onAgentStart handler failed: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    },
                    onAgentEnd() {
                        try {
                            bridge?.postEmbed(`⏹️ Agent Completed`, [{ name: 'Status', value: 'Done' }], 0x57F287)
                                .catch(err => log.warn(`discord postEmbed failed: ${err?.message ?? err}`));
                        } catch (err) {
                            log.warn(`discord onAgentEnd handler failed: ${err instanceof Error ? err.message : String(err)}`);
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

        pi.on("tool_call", async (event: any) => {
            if (!bridge) return;
            const toolName = event.toolUseBlock?.name ?? event.name ?? "unknown";
            const toolInput = event.toolUseBlock?.input ?? event.input ?? {};
            // Bridge doesn't expose onToolCall callback from here; it's handled via startBridge args
            // This placeholder is for future event processing if needed
        });

        pi.on("tool_result", async (event: any) => {
            if (!bridge) return;
            const result = event.result ?? event.content ?? "(no result)";
            // Bridge doesn't expose onToolResult callback from here; it's handled via startBridge args
            // This placeholder is for future event processing if needed
        });

        pi.on("message_start", async () => {
            if (!bridge) return;
            // Message start events handled via startBridge onMessageStart callback
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
