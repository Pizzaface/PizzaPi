import {
    ChannelType,
    Client,
    GatewayIntentBits,
    type Message,
    type MessageCreateOptions,
    type TextChannel,
} from "discord.js";
import type {
    Channel,
    InboundMessage,
    InboundMessageHandler,
    MessageProvider,
    OutboundMessage,
    ParsedCommand,
    ProviderConfig,
} from "./types.js";

const DEFAULT_COMMAND_PREFIX = "!";

/**
 * Discord-backed implementation of the MessageProvider abstraction.
 *
 * Bridges discord.js events and channels to PizzaPi's generic inbound/outbound
 * message model. Commands are detected using the default router's commandPrefix
 * (default "!").
 */
export class DiscordProvider implements MessageProvider {
    readonly id = "discord";
    readonly label = "Discord";

    private client: Client | null = null;
    private config: ProviderConfig | null = null;
    private connected = false;
    private readonly handlers = new Set<InboundMessageHandler>();
    private readonly providedClient?: Client;
    private botUserId: string | null = null;

    constructor(client?: Client) {
        this.providedClient = client;
    }

    async connect(config: ProviderConfig): Promise<void> {
        this.config = config;

        this.client =
            this.providedClient ??
            new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.GuildMembers,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMessageReactions,
                ],
            });

        this.client.once("ready", () => {
            this.botUserId = this.client?.user?.id ?? null;
            this.connected = true;
        });

        this.client.on("messageCreate", (message) => {
            void this.handleMessageCreate(message);
        });

        try {
            await this.client.login(config.token);
        } catch (err) {
            this.connected = false;
            this.cleanupClient();
            throw err;
        }
    }

    async disconnect(): Promise<void> {
        this.cleanupClient();
        this.connected = false;
        this.config = null;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async send(channelId: string, message: OutboundMessage): Promise<void> {
        if (!this.client) {
            throw new Error("DiscordProvider is not connected");
        }

        const targetId = message.threadId ?? channelId;
        const channel = await this.client.channels.fetch(targetId);
        if (!channel) {
            throw new Error(`Channel ${targetId} not found`);
        }

        if (!channel.isTextBased()) {
            throw new Error(`Channel ${targetId} is not text-based`);
        }

        const textChannel = channel as TextChannel;
        const options: MessageCreateOptions = { content: message.content };
        if (message.replyToId) {
            options.reply = { messageReference: message.replyToId };
        }

        await textChannel.send(options);
    }

    async listChannels(): Promise<Channel[]> {
        if (!this.client) {
            return [];
        }

        const channels: Channel[] = [];
        for (const guild of this.client.guilds.cache.values()) {
            for (const ch of guild.channels.cache.values()) {
                if (ch.type === ChannelType.GuildText) {
                    channels.push({ id: ch.id, name: ch.name, type: "text" });
                }
            }
        }
        return channels;
    }

    onMessage(handler: InboundMessageHandler): void {
        this.handlers.add(handler);
    }

    offMessage(handler: InboundMessageHandler): void {
        this.handlers.delete(handler);
    }

    /** Internal test hook to exercise message conversion. */
    _convertMessage(message: Message): InboundMessage {
        return this.convertMessage(message);
    }

    private convertMessage(message: Message): InboundMessage {
        const prefix = this.config?.defaultRouter?.commandPrefix ?? DEFAULT_COMMAND_PREFIX;
        const mentionedBot = this.botUserId !== null && isBotMention(message.content, this.botUserId);
        // Strip mention prefix when in mentions mode so the rest is treated as payload
        const contentForParsing = mentionedBot && this.botUserId
            ? message.content.replace(new RegExp(`<@!?${escapeRegex(this.botUserId)}>`), "").trim()
            : message.content;
        const command = mentionedBot
            ? parseMentionCommand(contentForParsing)
            : parseCommand(message.content, prefix);

        return {
            id: message.id,
            channelId: message.channelId,
            channelName: getChannelName(message.channel),
            author: {
                id: message.author.id,
                username: message.author.username,
                displayName: message.author.displayName ?? message.author.username,
            },
            content: message.content,
            timestamp: message.createdTimestamp,
            isCommand: command !== undefined,
            mentionedBot,
            command,
            raw: message,
            threadId: message.thread?.id,
            replyToId: message.reference?.messageId ?? undefined,
        };
    }

    private async handleMessageCreate(discordMessage: Message): Promise<void> {
        try {
            const message = this.convertMessage(discordMessage);
            for (const handler of this.handlers) {
                try {
                    const result = handler(message);
                    if (result instanceof Promise) {
                        await result.catch(() => undefined);
                    }
                } catch (err) {
                    // Isolate handler errors so one bad handler cannot break the rest.
                }
            }
        } catch (err) {
            // Swallow conversion/dispatch errors to avoid crashing the client.
        }
    }

    private cleanupClient(): void {
        if (this.client) {
            this.client.removeAllListeners();
            void this.client.destroy();
            this.client = null;
        }
    }
}

function parseCommand(content: string, prefix: string): ParsedCommand | undefined {
    const trimmed = content.trim();
    if (!trimmed.startsWith(prefix)) {
        return undefined;
    }

    const raw = trimmed.slice(prefix.length).trim();
    if (!raw) {
        return undefined;
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    const [name, ...args] = parts;
    if (!name) {
        return undefined;
    }

    return { name, args, raw };
}

function getChannelName(channel: { name?: string } | unknown): string {
    if (channel && typeof channel === "object" && "name" in channel && typeof (channel as { name?: unknown }).name === "string") {
        return (channel as { name: string }).name;
    }
    return "DM";
}

/** Detect a Discord bot mention in message content (<@BOTID> or <@!BOTID>). */
function isBotMention(content: string, botUserId: string): boolean {
    return new RegExp(`<@!?${escapeRegex(botUserId)}>`).test(content);
}

/** Parse text content after a mention has been stripped into a command. */
function parseMentionCommand(content: string): ParsedCommand | undefined {
    const trimmed = content.trim();
    if (!trimmed) {
        // Bare mention — forward as a "ping" command so the bridge can respond
        return { name: "ping", args: [], raw: "" };
    }
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const [name, ...args] = parts;
    return name ? { name, args, raw: trimmed } : undefined;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
