import type {
    ChannelRouterConfig,
    ChannelSession,
    InboundMessage,
    InboundMessageHandler,
    MessageProvider,
    OutboundMessage,
    ProviderConfig,
    ProviderStatus,
} from "./types.js";
import { ChannelRouter, type RouteResult } from "./channel-router.js";

interface ProviderEntry {
    provider: MessageProvider;
    config?: ProviderConfig;
}

interface ProviderMetrics {
    messagesIn: number;
    messagesOut: number;
    lastError?: string;
}

export type RoutedInboundMessageHandler = (
    message: InboundMessage,
    route: RouteResult,
) => void | Promise<void>;

/**
 * Manages the lifecycle, routing, and metrics of registered message providers.
 *
 * Each provider gets its own ChannelRouter instance so that per-provider
 * channel mappings and router configs stay isolated.
 */
export class ProviderRegistry {
    private readonly providers = new Map<string, ProviderEntry>();
    private readonly metrics = new Map<string, ProviderMetrics>();
    private readonly routers = new Map<string, ChannelRouter>();
    private readonly providerMessageHandlers = new Map<string, InboundMessageHandler>();
    private readonly routedHandlers: RoutedInboundMessageHandler[] = [];

    /**
     * Register a provider and its optional initial config.
     * Throws if the provider id is already registered.
     */
    register(provider: MessageProvider, config?: ProviderConfig): void {
        if (this.providers.has(provider.id)) {
            throw new Error(`ProviderRegistry: duplicate provider id "${provider.id}"`);
        }

        this.providers.set(provider.id, { provider, config });
        this.metrics.set(provider.id, { messagesIn: 0, messagesOut: 0 });
        this.routers.set(provider.id, new ChannelRouter());

        const handler = this.createProviderMessageHandler(provider.id);
        this.providerMessageHandlers.set(provider.id, handler);
        provider.onMessage(handler);
    }

    /**
     * Unregister a provider, disconnecting it if connected and cleaning up
     * listeners.
     */
    async unregister(id: string): Promise<void> {
        const entry = this.providers.get(id);
        if (!entry) {
            return;
        }

        try {
            if (entry.provider.isConnected()) {
                await entry.provider.disconnect();
            }
        } catch (err) {
            this.recordError(id, err);
        }

        const handler = this.providerMessageHandlers.get(id);
        if (handler) {
            entry.provider.offMessage(handler);
        }

        this.providers.delete(id);
        this.metrics.delete(id);
        this.routers.delete(id);
        this.providerMessageHandlers.delete(id);
    }

    /**
     * Update the stored config for a provider.
     */
    setConfig(id: string, config: ProviderConfig): void {
        const entry = this.providers.get(id);
        if (!entry) {
            throw new Error(`ProviderRegistry: unknown provider "${id}"`);
        }
        entry.config = config;
        this.rebuildRouter(id, config);
    }

    /**
     * Return the stored config for a provider, if any.
     */
    getConfig(id: string): ProviderConfig | undefined {
        return this.providers.get(id)?.config;
    }

    /**
     * Look up a registered provider by id.
     */
    getProvider(id: string): MessageProvider | undefined {
        return this.providers.get(id)?.provider;
    }

    /**
     * Return all registered providers.
     */
    getProviders(): MessageProvider[] {
        return Array.from(this.providers.values()).map((entry) => entry.provider);
    }

    /**
     * Connect a single provider using its stored config.
     */
    async connect(id: string): Promise<void> {
        const entry = this.providers.get(id);
        if (!entry) {
            throw new Error(`ProviderRegistry: unknown provider "${id}"`);
        }
        if (!entry.config) {
            throw new Error(`ProviderRegistry: no config for provider "${id}"`);
        }

        try {
            await entry.provider.connect(entry.config);
        } catch (err) {
            this.recordError(id, err);
            throw err;
        }
    }

    /**
     * Connect all registered providers that have a stored config.
     * Individual connection failures are recorded but do not stop others.
     */
    async connectAll(): Promise<void> {
        for (const id of this.providers.keys()) {
            const config = this.providers.get(id)?.config;
            if (!config) {
                continue;
            }
            try {
                await this.connect(id);
            } catch (err) {
                // Error already recorded by connect(); continue with others.
                if (err instanceof Error) {
                    this.recordError(id, err);
                }
            }
        }
    }

    /**
     * Disconnect a single provider.
     */
    async disconnect(id: string): Promise<void> {
        const entry = this.providers.get(id);
        if (!entry) {
            throw new Error(`ProviderRegistry: unknown provider "${id}"`);
        }

        try {
            await entry.provider.disconnect();
        } catch (err) {
            this.recordError(id, err);
            throw err;
        }
    }

    /**
     * Disconnect all registered providers.
     * Individual disconnection failures are recorded but do not stop others.
     */
    async disconnectAll(): Promise<void> {
        for (const id of this.providers.keys()) {
            try {
                await this.disconnect(id);
            } catch (err) {
                if (err instanceof Error) {
                    this.recordError(id, err);
                }
            }
        }
    }

    /**
     * Send an outbound message through a provider and update metrics.
     */
    async send(providerId: string, channelId: string, message: OutboundMessage): Promise<void> {
        const entry = this.providers.get(providerId);
        if (!entry) {
            throw new Error(`ProviderRegistry: unknown provider "${providerId}"`);
        }

        try {
            await entry.provider.send(channelId, message);
            this.incrementMessagesOut(providerId);
        } catch (err) {
            this.recordError(providerId, err);
            throw err;
        }
    }

    /**
     * Add a channel-to-session mapping for a provider.
     */
    addChannelSession(providerId: string, session: ChannelSession): void {
        const router = this.getRouter(providerId);
        router.addSession(session);
    }

    /**
     * Remove a channel-to-session mapping for a provider.
     */
    removeChannelSession(providerId: string, channelId: string): void {
        const router = this.getRouter(providerId);
        router.removeSession(channelId);
    }

    /**
     * Return the router for a provider.
     */
    getRouter(providerId: string): ChannelRouter {
        const router = this.routers.get(providerId);
        if (!router) {
            throw new Error(`ProviderRegistry: unknown provider "${providerId}"`);
        }
        return router;
    }

    /**
     * Return all channel sessions mapped to a given PizzaPi session ID for a
     * specific provider.
     */
    getChannelsForSession(providerId: string, sessionId: string): ChannelSession[] {
        return this.getRouter(providerId).findChannelsBySessionId(sessionId);
    }

    /**
     * Register a handler for routed inbound messages.
     */
    onRoutedMessage(handler: RoutedInboundMessageHandler): void {
        if (!this.routedHandlers.includes(handler)) {
            this.routedHandlers.push(handler);
        }
    }

    /**
     * Remove a routed inbound message handler.
     */
    offRoutedMessage(handler: RoutedInboundMessageHandler): void {
        const index = this.routedHandlers.indexOf(handler);
        if (index >= 0) {
            this.routedHandlers.splice(index, 1);
        }
    }

    /**
     * Return status snapshots for all registered providers.
     */
    getStatus(): ProviderStatus[] {
        return Array.from(this.providers.entries()).map(([id, entry]) => {
            const metrics = this.metrics.get(id) ?? { messagesIn: 0, messagesOut: 0 };
            const router = this.routers.get(id);
            const sessionsMapped = router?.getSessions().length ?? 0;

            return {
                id,
                label: entry.provider.label,
                connected: entry.provider.isConnected(),
                channelCount: entry.provider.isConnected() ? sessionsMapped : 0,
                sessionsMapped,
                messagesIn: metrics.messagesIn,
                messagesOut: metrics.messagesOut,
                lastError: metrics.lastError,
            };
        });
    }

    private createProviderMessageHandler(providerId: string): InboundMessageHandler {
        return (message: InboundMessage) => {
            this.incrementMessagesIn(providerId);

            const config = this.providers.get(providerId)?.config;
            if (!this.isChannelAllowed(message.channelId, config?.allowedChannels)) {
                return;
            }

            const router = this.routers.get(providerId);
            if (!router) {
                return;
            }

            const route = router.route(message);
            if (!route || !route.shouldForward) {
                return;
            }

            for (const handler of this.routedHandlers) {
                try {
                    const result = handler(route.message, route);
                    if (result instanceof Promise) {
                        result.catch((err) => this.recordError(providerId, err));
                    }
                } catch (err) {
                    this.recordError(providerId, err);
                }
            }
        };
    }

    private isChannelAllowed(channelId: string, allowedChannels?: string[]): boolean {
        if (!allowedChannels || allowedChannels.length === 0) {
            return true;
        }
        return allowedChannels.includes(channelId);
    }

    private rebuildRouter(id: string, config: ProviderConfig): void {
        const router = this.getRouter(id);
        if (config.defaultRouter) {
            router.setDefaultRouter(config.defaultRouter);
        }
        for (const session of router.getSessions()) {
            const channelConfig = config.channelRouters?.[session.channelId];
            if (channelConfig) {
                router.addSession({ ...session, config: channelConfig });
            }
        }
    }

    private incrementMessagesIn(id: string): void {
        const metrics = this.metrics.get(id);
        if (metrics) {
            metrics.messagesIn += 1;
        }
    }

    private incrementMessagesOut(id: string): void {
        const metrics = this.metrics.get(id);
        if (metrics) {
            metrics.messagesOut += 1;
        }
    }

    private recordError(id: string, error: unknown): void {
        const metrics = this.metrics.get(id);
        if (!metrics) {
            return;
        }
        if (error instanceof Error) {
            metrics.lastError = error.message;
        } else {
            metrics.lastError = String(error);
        }
    }
}
