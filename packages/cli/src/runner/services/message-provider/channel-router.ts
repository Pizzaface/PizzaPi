import type {
    CanExecutePolicy,
    ChannelRouterConfig,
    ChannelSession,
    InboundMessage,
    ParsedCommand,
} from "./types.js";

export interface RouteResult {
    /** The mapped PizzaPi session ID. */
    sessionId: string;
    /** Router config that determined the route. */
    config: ChannelRouterConfig;
    /** Whether the message should be forwarded to the session. */
    shouldForward: boolean;
    /** The parsed (possibly truncated) message. */
    message: InboundMessage;
}

const DEFAULT_PREFIX = "!";
const DEFAULT_ROUTER: ChannelRouterConfig = { mode: "commands-only", commandPrefix: DEFAULT_PREFIX };

/**
 * Routes inbound platform messages to PizzaPi sessions.
 *
 * Responsibilities:
 * - Maintains channelId → session mappings.
 * - Parses command prefixes and extracts command names/args.
 * - Applies per-channel router rules (mode, filters, truncation).
 * - Decides whether a given message should be forwarded.
 */
export class ChannelRouter {
    private readonly sessions = new Map<string, ChannelSession>();
    private defaultRouter: ChannelRouterConfig = DEFAULT_ROUTER;

    /**
     * Register a channel-to-session mapping.
     * Overwrites any existing mapping for the same channelId.
     */
    addSession(session: ChannelSession): void {
        this.sessions.set(session.channelId, session);
    }

    /**
     * Remove a channel-to-session mapping.
     */
    removeSession(channelId: string): void {
        this.sessions.delete(channelId);
    }

    /**
     * Replace the default router config used for mapped channels that do not
     * carry their own config.
     */
    setDefaultRouter(config: ChannelRouterConfig): void {
        this.defaultRouter = config;
    }

    /**
     * Return all currently mapped sessions.
     */
    getSessions(): ChannelSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Return channel sessions mapped to a specific PizzaPi session ID.
     */
    findChannelsBySessionId(sessionId: string): ChannelSession[] {
        return this.getSessions().filter((session) => session.sessionId === sessionId);
    }

    /**
     * Return the mapped session for a channel, if any.
     */
    getSession(channelId: string): ChannelSession | undefined {
        return this.sessions.get(channelId);
    }

    /**
     * Parse an inbound message: detect commands, truncate if needed, and return
     * a new message object with derived fields populated.
     */
    parseMessage(
        message: InboundMessage,
        config: ChannelRouterConfig = this.defaultRouter,
    ): InboundMessage {
        const prefix = config.commandPrefix ?? DEFAULT_PREFIX;
        const command = parseCommand(message.content, prefix);
        const content = applyMaxLength(message.content, config.maxMessageLength);

        return {
            ...message,
            content,
            isCommand: command !== undefined,
            command,
        };
    }

    /**
     * Route a message to a mapped session. Returns undefined when the channel is
     * not mapped.
     */
    async route(message: InboundMessage): Promise<RouteResult | undefined> {
        const session = this.sessions.get(message.channelId);
        if (!session) {
            return undefined;
        }

        const config = session.config ?? this.defaultRouter;
        const parsed = this.parseMessage(message, config);

        let shouldForward = false;
        try {
            shouldForward = await this.shouldForward(parsed, config);
        } catch (err) {
            // A canExecute policy threw — drop the message rather than crash routing.
            return {
                sessionId: session.sessionId,
                config,
                shouldForward: false,
                message: parsed,
            };
        }

        return {
            sessionId: session.sessionId,
            config,
            shouldForward,
            message: parsed,
        };
    }

    /**
     * Decide whether a parsed message should be forwarded, based on the router
     * mode, filters, and optional authorization policy.
     */
    private async shouldForward(message: InboundMessage, config: ChannelRouterConfig): Promise<boolean> {
        if (config.canExecute) {
            const result = await config.canExecute(message);
            if (!result.allowed) {
                return false;
            }
        }

        switch (config.mode) {
            case "all-messages":
                return true;
            case "commands-only":
                return message.isCommand;
            case "mentions":
                return message.mentionedBot === true;
            case "filtered":
                return matchesFilter(message.content, config.filterPatterns);
            default:
                return false;
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

function applyMaxLength(content: string, maxLength?: number): string {
    if (maxLength === undefined || maxLength <= 0 || content.length <= maxLength) {
        return content;
    }
    return content.slice(0, maxLength);
}

function matchesFilter(content: string, patterns?: string[]): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }
    return patterns.some((pattern) => content.includes(pattern));
}
