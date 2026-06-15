/**
 * MessageBridgeService — runner service that wires external message providers
 * (Discord, Slack, Telegram, etc.) to PizzaPi's trigger system and relay.
 *
 * Responsibilities:
 *   - Create provider instances from ~/.pizzapi/config.json.
 *   - Forward routed inbound messages as `message-bridge:inbound` triggers.
 *   - Track `message-bridge:send` subscriptions so send confirmations can be
 *     broadcast back to listening sessions.
 *   - Expose a small panel HTTP API for status, channel listing, sending, and
 *     config validation.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import type { ReconcileOptions, ServiceHandler, ServiceInitOptions } from "../../service-handler.js";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { DiscordProvider } from "./discord-provider.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { InboundMessage, MessageProvider, OutboundMessage, ProviderConfig, ProviderStatus } from "./types.js";
import { validateProviderConfig } from "./types.js";

type BunServer = import("bun").Server<unknown>;

// ── Config helpers ───────────────────────────────────────────────────────────

export interface MessageBridgeConfig {
    enabled?: boolean;
    discord?: ProviderConfig;
    slack?: ProviderConfig;
    telegram?: ProviderConfig;
    /** Additional provider-specific configs. */
    [providerId: string]: unknown;
}

function readRunnerId(): string | null {
    try {
        const home = process.env.HOME || homedir();
        const raw = JSON.parse(readFileSync(join(home, ".pizzapi", "runner.json"), "utf-8"));
        return typeof raw?.runnerId === "string" ? raw.runnerId : null;
    } catch {
        return null;
    }
}

function resolveRelayUrl(): string {
    let raw = process.env.PIZZAPI_RELAY_URL?.trim();
    if (!raw) {
        try {
            const home = process.env.HOME || homedir();
            const cfg = JSON.parse(readFileSync(join(home, ".pizzapi", "config.json"), "utf-8"));
            if (typeof cfg?.relayUrl === "string" && cfg.relayUrl !== "off") raw = cfg.relayUrl.trim();
        } catch {
            /* ignore */
        }
    }
    raw = raw || "http://localhost:7492";
    if (raw.startsWith("ws://")) return raw.replace(/^ws:/, "http:").replace(/\/$/, "");
    if (raw.startsWith("wss://")) return raw.replace(/^wss:/, "https:").replace(/\/$/, "");
    return raw.replace(/\/$/, "");
}

function getApiKey(): string | null {
    return process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? null;
}

function readBridgeConfig(): MessageBridgeConfig | undefined {
    try {
        const home = process.env.HOME || homedir();
        const cfg = JSON.parse(readFileSync(join(home, ".pizzapi", "config.json"), "utf-8"));
        const bridge = cfg?.providers?.["message-bridge"];
        if (bridge && typeof bridge === "object") {
            return bridge as MessageBridgeConfig;
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

// ── Provider factory ─────────────────────────────────────────────────────────

export type ProviderFactory = () => MessageProvider;

const DEFAULT_PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
    discord: () => new DiscordProvider(),
};

// ── Service implementation ───────────────────────────────────────────────────

export interface MessageBridgeServiceOptions {
    /** Pre-loaded bridge config; falls back to ~/.pizzapi/config.json if omitted. */
    config?: MessageBridgeConfig;
    /** Provider factories keyed by provider id; defaults to Discord only. */
    factories?: Record<string, ProviderFactory>;
}

export class MessageBridgeService implements ServiceHandler {
    readonly id = "message-bridge";

    #config: MessageBridgeConfig | undefined;
    #factories: Record<string, ProviderFactory>;
    #registry = new ProviderRegistry();
    #server: BunServer | null = null;
    #sendSessions = new Set<string>();
    #initialized = false;

    constructor(options: MessageBridgeServiceOptions = {}) {
        this.#config = options.config;
        this.#factories = { ...DEFAULT_PROVIDER_FACTORIES, ...(options.factories ?? {}) };
    }

    init(socket: Socket, { announcePanel }: ServiceInitOptions): void {
        if (this.#initialized) return;
        this.#initialized = true;

        const bridgeConfig = this.#config ?? readBridgeConfig();
        if (bridgeConfig?.enabled !== false) {
            this.#registerProviders(bridgeConfig);
        }

        // Connect providers. Individual failures are recorded and do not stop others.
        this.#registry.connectAll().catch((err) => {
            this.#logError(`connectAll failed: ${err instanceof Error ? err.message : String(err)}`);
        });

        this.#server = Bun.serve({
            port: 0,
            fetch: (req) => this.#handlePanelRequest(req),
        });

        const port = this.#server.port;
        if (announcePanel && port) {
            announcePanel(port);
        }
    }

    dispose(): void {
        if (this.#server) {
            this.#server.stop(true);
            this.#server = null;
        }

        this.#registry.disconnectAll().catch((err) => {
            this.#logError(`disconnectAll failed: ${err instanceof Error ? err.message : String(err)}`);
        });

        this.#sendSessions.clear();
        this.#initialized = false;
    }

    reconcileSubscriptions(subscriptions: TriggerSubscriptionEntry[], options: ReconcileOptions = {}): { applied: number; errors?: string[] } {
        const mode = options.mode ?? "snapshot";
        const action = options.action ?? "subscribe";

        const sendSubs = subscriptions.filter((s) => s.triggerType === "message-bridge:send");

        if (mode === "snapshot") {
            this.#sendSessions.clear();
            for (const sub of sendSubs) {
                this.#sendSessions.add(sub.sessionId);
            }
        } else {
            for (const sub of sendSubs) {
                if (action === "unsubscribe") {
                    this.#sendSessions.delete(sub.sessionId);
                } else {
                    this.#sendSessions.add(sub.sessionId);
                }
            }
        }

        return { applied: sendSubs.length };
    }

    /** Direct access to the underlying registry (mostly for tests). */
    getRegistry(): ProviderRegistry {
        return this.#registry;
    }

    /** Current set of sessions subscribed to `message-bridge:send` (mostly for tests). */
    getSendSessions(): ReadonlySet<string> {
        return this.#sendSessions;
    }

    /** Current panel server port, or undefined if not started. */
    getPanelPort(): number | undefined {
        return this.#server?.port;
    }

    // ── Provider lifecycle ─────────────────────────────────────────────────

    #registerProviders(bridgeConfig?: MessageBridgeConfig): void {
        if (!bridgeConfig) return;

        for (const [providerId, rawConfig] of Object.entries(bridgeConfig)) {
            if (providerId === "enabled") continue;
            if (!rawConfig || typeof rawConfig !== "object") {
                this.#logWarn(`skipping provider "${providerId}": config is not an object`);
                continue;
            }

            const factory = this.#factories[providerId];
            if (!factory) {
                this.#logWarn(`no factory registered for provider "${providerId}"`);
                continue;
            }

            const validation = validateProviderConfig(rawConfig);
            if (!validation.valid) {
                this.#logWarn(
                    `provider "${providerId}" config invalid: ${validation.errors.join(", ")}`,
                );
                continue;
            }

            try {
                const provider = factory();
                this.#registry.register(provider, rawConfig as ProviderConfig);
                // Forward inbound messages as triggers to the relay.
                provider.onMessage((inbound) => {
                    void this.#broadcastInbound(provider.id, inbound);
                });
            } catch (err) {
                this.#logError(
                    `failed to register provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    // ── Panel HTTP handlers ────────────────────────────────────────────────────

    async #handlePanelRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const cors = this.#corsHeaders();

        if (req.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    ...cors,
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                },
            });
        }

        try {
            if (url.pathname === "/api/status" && req.method === "GET") {
                return Response.json(this.#registry.getStatus(), { headers: cors });
            }

            if (url.pathname.startsWith("/api/channels/") && req.method === "GET") {
                const providerId = url.pathname.slice("/api/channels/".length);
                return await this.#handleListChannels(providerId, cors);
            }

            if (url.pathname === "/api/send" && req.method === "POST") {
                return await this.#handleSend(req, cors);
            }

            if (url.pathname === "/api/config/test" && req.method === "POST") {
                return await this.#handleConfigTest(req, cors);
            }

            return Response.json({ error: "Not found" }, { status: 404, headers: cors });
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 500, headers: cors },
            );
        }
    }

    async #handleListChannels(providerId: string, cors: Record<string, string>): Promise<Response> {
        const provider = this.#registry.getProvider(providerId);
        if (!provider) {
            return Response.json({ error: "Provider not found" }, { status: 404, headers: cors });
        }

        try {
            const channels = await provider.listChannels();
            return Response.json(channels, { headers: cors });
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 500, headers: cors },
            );
        }
    }

    async #handleSend(req: Request, cors: Record<string, string>): Promise<Response> {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
        }

        if (!body || typeof body !== "object") {
            return Response.json({ error: "Body must be an object" }, { status: 400, headers: cors });
        }

        const { providerId, channelId, content, threadId, replyToId } = body as Record<string, unknown>;

        if (typeof providerId !== "string" || typeof channelId !== "string" || typeof content !== "string") {
            return Response.json(
                { error: "providerId, channelId, and content are required strings" },
                { status: 400, headers: cors },
            );
        }

        const message: OutboundMessage = {
            content,
            threadId: typeof threadId === "string" ? threadId : undefined,
            replyToId: typeof replyToId === "string" ? replyToId : undefined,
        };
        try {
            await this.#registry.send(providerId, channelId, message);
            void this.#broadcastSend(providerId, channelId, content);
            return Response.json({ success: true }, { headers: cors });
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 500, headers: cors },
            );
        }
    }

    async #handleConfigTest(req: Request, cors: Record<string, string>): Promise<Response> {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
        }

        if (!body || typeof body !== "object") {
            return Response.json(
                { valid: false, errors: ["Config must be an object"] },
                { status: 400, headers: cors },
            );
        }

        const results: Array<{ providerId: string; result: ReturnType<typeof validateProviderConfig> }> = [];
        let hasProviderConfig = false;

        for (const [providerId, rawConfig] of Object.entries(body as Record<string, unknown>)) {
            if (providerId === "enabled") continue;
            if (!rawConfig || typeof rawConfig !== "object") continue;
            hasProviderConfig = true;
            results.push({
                providerId,
                result: validateProviderConfig(rawConfig),
            });
        }

        if (!hasProviderConfig) {
            return Response.json(
                { valid: false, errors: ["No provider config to validate"] },
                { status: 400, headers: cors },
            );
        }

        const allValid = results.every((r) => r.result.valid);
        return Response.json(
            { valid: allValid, results },
            { headers: cors },
        );
    }

    #corsHeaders(): Record<string, string> {
        return { "Access-Control-Allow-Origin": "*" };
    }

    // ── Trigger broadcasting ─────────────────────────────────────────────────

    async #broadcastInbound(providerId: string, inbound: InboundMessage): Promise<void> {
        await this.#broadcastTrigger("message-bridge:inbound", {
            providerId,
            channelId: inbound.channelId,
            channelName: inbound.channelName,
            author: inbound.author,
            content: inbound.content,
            isCommand: inbound.isCommand,
            command: inbound.command,
            threadId: inbound.threadId,
            replyToId: inbound.replyToId,
            messageId: inbound.id,
        }, { summary: `Message from ${inbound.author.displayName} in ${inbound.channelName}` });
    }

    async #broadcastSend(providerId: string, channelId: string, content: string): Promise<void> {
        await this.#broadcastTrigger("message-bridge:send", {
            providerId,
            channelId,
            content,
            messageId: undefined,
        });
    }

    async #broadcastTrigger(
        type: string,
        payload: Record<string, unknown>,
        opts?: { deliverAs?: "steer" | "followUp"; summary?: string },
    ): Promise<void> {
        const runnerId = readRunnerId();
        const apiKey = getApiKey();
        if (!runnerId || !apiKey) {
            this.#logWarn(`cannot broadcast ${type}: missing runnerId or apiKey`);
            return;
        }

        try {
            const res = await fetch(`${resolveRelayUrl()}/api/runners/${runnerId}/trigger-broadcast`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                body: JSON.stringify({
                    type,
                    payload,
                    source: "message-bridge",
                    deliverAs: opts?.deliverAs ?? "followUp",
                    summary: opts?.summary,
                }),
            });

            if (!res.ok) {
                this.#logWarn(`trigger broadcast failed: ${res.status} ${res.statusText}`);
            }
        } catch (err) {
            this.#logError(`trigger broadcast error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // ── Logging helpers ──────────────────────────────────────────────────────

    #logWarn(message: string): void {
        // eslint-disable-next-line no-console
        console.warn(`[message-bridge] ${message}`);
    }

    #logError(message: string): void {
        // eslint-disable-next-line no-console
        console.error(`[message-bridge] ${message}`);
    }
}
