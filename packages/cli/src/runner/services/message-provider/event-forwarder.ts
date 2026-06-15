import type { OutboundMessage, SessionEventType } from "./types.js";
import type { ProviderRegistry } from "./provider-registry.js";

export interface SessionEvent {
    /** Type of session event being forwarded. */
    type: SessionEventType;
    /** PizzaPi session ID the event relates to. */
    sessionId: string;
    /** Extra context used when rendering templates. */
    payload?: Record<string, unknown>;
}

export type MessageTemplate = string;

const DEFAULT_TEMPLATES: Record<SessionEventType, MessageTemplate> = {
    "session.start": "Session {{sessionId}} started",
    "session.complete": "Session {{sessionId}} completed",
    "session.error": "Session {{sessionId}} errored: {{message}}",
    "session.turn_end": "Session {{sessionId}} turn ended",
    "build.success": "Build succeeded for session {{sessionId}}",
    "build.failure": "Build failed for session {{sessionId}}: {{message}}",
    "review.lgtm": "Review LGTM for session {{sessionId}}",
    "review.failed": "Review failed for session {{sessionId}}: {{message}}",
};

/**
 * Forwards PizzaPi session lifecycle events to message providers that have
 * configured `forwardEvents`.
 *
 * Supports per-event-type message templates. Templates use simple {{key}}
 * placeholders resolved from the event payload (with the sessionId always
 * available).
 */
export class EventForwarder {
    private readonly templates: Record<SessionEventType, MessageTemplate>;

    constructor(
        private readonly registry: ProviderRegistry,
        templates?: Partial<Record<SessionEventType, MessageTemplate>>,
    ) {
        this.templates = { ...DEFAULT_TEMPLATES, ...templates };
    }

    /**
     * Forward a session event to every connected provider that has subscribed
     * to this event type, targeting only channels mapped to the event session.
     */
    async forward(event: SessionEvent): Promise<void> {
        const content = renderTemplate(this.templates[event.type], event.sessionId, event.payload);
        const message: OutboundMessage = { content };

        const statuses = this.registry.getStatus();
        const results = statuses
            .filter((status) => status.connected)
            .map(async (status) => {
                const config = this.registry.getConfig(status.id);
                if (!config || !config.forwardEvents || !config.forwardEvents.includes(event.type)) {
                    return;
                }

                const channels = this.registry.getChannelsForSession(status.id, event.sessionId);
                if (channels.length === 0) {
                    return;
                }

                await Promise.all(
                    channels.map((channel) =>
                        this.registry.send(status.id, channel.channelId, message).catch((err) => {
                            // Errors are recorded by ProviderRegistry.send.
                            // Surface to console for debugging but do not fail
                            // other providers/channels.
                            if (err instanceof Error) {
                                console.error(`[EventForwarder] ${status.id}/${channel.channelId}: ${err.message}`);
                            }
                        }),
                    ),
                );
            });

        await Promise.all(results);
    }

    /**
     * Return a copy of the current template map.
     */
    getTemplates(): Record<SessionEventType, MessageTemplate> {
        return { ...this.templates };
    }

    /**
     * Update a single event template.
     */
    setTemplate(type: SessionEventType, template: MessageTemplate): void {
        this.templates[type] = template;
    }
}

function renderTemplate(
    template: string,
    sessionId: string,
    payload?: Record<string, unknown>,
): string {
    const context: Record<string, unknown> = { sessionId, ...(payload ?? {}) };
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const value = context[key];
        return value === undefined || value === null ? "" : String(value);
    });
}
