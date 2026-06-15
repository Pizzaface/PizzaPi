export interface MessageProvider {
    /** Unique provider identifier (e.g., "discord", "slack") */
    readonly id: string;

    /** Human-readable display name */
    readonly label: string;

    /** Connect the provider and start receiving messages */
    connect(config: ProviderConfig): Promise<void>;

    /** Disconnect and clean up resources */
    disconnect(): Promise<void>;

    /** Whether the provider is currently connected */
    isConnected(): boolean;

    /** Send a message to a specific channel */
    send(channelId: string, message: OutboundMessage): Promise<void>;

    /** List available channels */
    listChannels(): Promise<Channel[]>;

    /** Register a handler for inbound messages */
    onMessage(handler: InboundMessageHandler): void;

    /** Remove the inbound message handler */
    offMessage(handler: InboundMessageHandler): void;
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;

export interface InboundMessage {
    /** Unique message ID from the platform */
    id: string;
    /** Channel/conversation the message was sent in */
    channelId: string;
    /** Channel display name */
    channelName: string;
    /** User/author who sent the message */
    author: MessageAuthor;
    /** Message content (plain text) */
    content: string;
    /** Timestamp (Unix ms) */
    timestamp: number;
    /** Whether this message contains a command prefix */
    isCommand: boolean;
    /** Parsed command (if isCommand) */
    command?: ParsedCommand;
    /** Raw provider-specific data */
    raw: unknown;
    /** Thread/reply context (if in a thread) */
    threadId?: string;
    /** Reply-to message ID */
    replyToId?: string;
}

export interface MessageAuthor {
    id: string;
    username: string;
    displayName: string;
}

export interface ParsedCommand {
    name: string;
    args: string[];
    raw: string;
}

export interface OutboundMessage {
    /** Text content */
    content: string;
    /** Optional target thread to reply in */
    threadId?: string;
    /** Optional message to reply to */
    replyToId?: string;
}

export interface Channel {
    id: string;
    name: string;
    type: "text" | "voice" | "category" | "thread" | "dm";
}

export interface ChannelSession {
    /** Platform channel ID */
    channelId: string;
    /** Mapped PizzaPi session ID */
    sessionId: string;
    /** Router config for this mapping */
    config: ChannelRouterConfig;
}

export interface ChannelRouterConfig {
    /** Command prefix to recognize (default "!") */
    commandPrefix?: string;
    /** Whether to forward all messages or only commands */
    mode: "commands-only" | "all-messages" | "filtered";
    /** Patterns for filtered mode */
    filterPatterns?: string[];
    /** Maximum message length (truncate longer) */
    maxMessageLength?: number;
}

export interface ProviderConfig {
    /** Platform-specific token/bot token */
    token: string;
    /** Allowed channel IDs (empty = all) */
    allowedChannels?: string[];
    /** Router config per channel (channelId → config) */
    channelRouters?: Record<string, ChannelRouterConfig>;
    /** Default router config for unmapped channels */
    defaultRouter?: ChannelRouterConfig;
    /** Events to forward from sessions to this channel */
    forwardEvents?: SessionEventType[];
    /** Platform-specific options */
    options?: Record<string, unknown>;
}

export type SessionEventType =
    | "session.start"
    | "session.complete"
    | "session.error"
    | "session.turn_end"
    | "build.success"
    | "build.failure"
    | "review.lgtm"
    | "review.failed";

export interface ProviderStatus {
    id: string;
    label: string;
    connected: boolean;
    channelCount: number;
    sessionsMapped: number;
    messagesIn: number;
    messagesOut: number;
    lastError?: string;
}

const SESSION_EVENT_TYPES: SessionEventType[] = [
    "session.start",
    "session.complete",
    "session.error",
    "session.turn_end",
    "build.success",
    "build.failure",
    "review.lgtm",
    "review.failed",
];

export function isSessionEventType(value: unknown): value is SessionEventType {
    return typeof value === "string" && SESSION_EVENT_TYPES.includes(value as SessionEventType);
}

export interface ConfigValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate a ProviderConfig-shaped object.
 *
 * Returns a list of human-readable errors without throwing.
 */
export function validateProviderConfig(config: unknown): ConfigValidationResult {
    const errors: string[] = [];

    if (config === null || typeof config !== "object") {
        return { valid: false, errors: ["ProviderConfig must be an object"] };
    }

    const c = config as Partial<ProviderConfig>;

    if (typeof c.token !== "string" || c.token.length === 0) {
        errors.push("token must be a non-empty string");
    }

    if (c.allowedChannels !== undefined) {
        if (!Array.isArray(c.allowedChannels) || !c.allowedChannels.every((id) => typeof id === "string")) {
            errors.push("allowedChannels must be an array of strings");
        }
    }

    if (c.channelRouters !== undefined) {
        if (typeof c.channelRouters !== "object" || c.channelRouters === null) {
            errors.push("channelRouters must be an object");
        } else {
            for (const [channelId, router] of Object.entries(c.channelRouters)) {
                if (!isValidChannelRouterConfig(router)) {
                    errors.push(`channelRouters["${channelId}"] is invalid`);
                }
            }
        }
    }

    if (c.defaultRouter !== undefined && !isValidChannelRouterConfig(c.defaultRouter)) {
        errors.push("defaultRouter is invalid");
    }

    if (c.forwardEvents !== undefined) {
        if (!Array.isArray(c.forwardEvents) || !c.forwardEvents.every(isSessionEventType)) {
            errors.push("forwardEvents must be an array of valid SessionEventType values");
        }
    }

    if (c.options !== undefined && (typeof c.options !== "object" || c.options === null)) {
        errors.push("options must be an object");
    }

    return { valid: errors.length === 0, errors };
}

function isValidChannelRouterConfig(config: unknown): config is ChannelRouterConfig {
    if (config === null || typeof config !== "object") {
        return false;
    }
    const c = config as Partial<ChannelRouterConfig>;

    const validModes: ChannelRouterConfig["mode"][] = ["commands-only", "all-messages", "filtered"];
    if (!validModes.includes(c.mode as ChannelRouterConfig["mode"])) {
        return false;
    }

    if (c.commandPrefix !== undefined && (typeof c.commandPrefix !== "string" || c.commandPrefix.length === 0)) {
        return false;
    }

    if (c.filterPatterns !== undefined && (!Array.isArray(c.filterPatterns) || !c.filterPatterns.every((p) => typeof p === "string"))) {
        return false;
    }

    if (c.maxMessageLength !== undefined && (typeof c.maxMessageLength !== "number" || c.maxMessageLength <= 0)) {
        return false;
    }

    return true;
}
