/**
 * Inter-session message bus.
 *
 * Singleton that mediates message passing between agent sessions via the relay
 * WebSocket. The remote extension feeds incoming messages into the bus and
 * provides the send callback; the session-messaging extension's tools read
 * from / write to the bus.
 */

export interface SessionMessage {
    /** Session ID of the sender */
    fromSessionId: string;
    /** The text content of the message */
    message: string;
    /** ISO timestamp when the message was sent */
    ts: string;
}

/**
 * Delivery mode for incoming inter-agent messages:
 *   - `"immediate"` — inject via sendUserMessage() now if idle, queue if busy
 *   - `"queued"`    — always queue; drain after current agent turn ends
 *   - `"blocked"`   — leave for manual poll via wait_for_message/check_messages (backward-compatible default)
 */
export type DeliveryMode = "immediate" | "queued" | "blocked";

type MessageListener = (msg: SessionMessage) => void;

/** Callback used by the bus to actually send a message over the relay WebSocket. */
type SendFn = (targetSessionId: string, message: string) => boolean;

/** Callback to emit a session_status_query via the relay socket. */
type StatusQueryFn = (requestId: string, targetSessionId: string) => boolean;

/** Callback for one-shot session_status_response events keyed by requestId. */
type StatusResponseListener = (data: { requestId: string; status: unknown | null }) => void;

/**
 * Callback fired when a message is ready for immediate injection.
 * The remote extension provides this; it calls pi.sendUserMessage().
 * Returns true if the message was injected, false if it should be queued.
 */
type MessageReadyCallback = (formattedMessage: string) => boolean;

class SessionMessageBus {
    /** Queued incoming messages, keyed by fromSessionId. "any" collects all. */
    private queues = new Map<string, SessionMessage[]>();
    /** Listeners waiting for a message. */
    private waiters: Array<{
        fromSessionId: string | null;
        resolve: MessageListener;
    }> = [];
    /** The relay send function, set by the remote extension once connected. */
    private sendFn: SendFn | null = null;
    /** This session's own ID (set by remote extension after registration). */
    private ownSessionId: string | null = null;
    /** Function to emit session_status_query events via the relay. */
    private statusQueryFn: StatusQueryFn | null = null;
    /** Pending session_status_response listeners keyed by requestId. */
    private statusResponseListeners = new Map<string, StatusResponseListener>();

    // ── Delivery mode & completion queue (PizzaPi-7x0.4) ─────────────────
    private deliveryMode: DeliveryMode = "blocked";
    /** Completion messages queue — higher priority than regular messages. */
    private completionQueue: SessionMessage[] = [];
    /** Regular auto-delivery queue (for queued/immediate modes). */
    private autoDeliveryQueue: SessionMessage[] = [];
    /** Callback for immediate injection. */
    private messageReadyFn: MessageReadyCallback | null = null;

    /** Called by remote extension to wire up the send path. */
    setSendFn(fn: SendFn | null): void {
        this.sendFn = fn;
    }

    /** Called by remote extension after relay registration. */
    setOwnSessionId(id: string): void {
        this.ownSessionId = id;
    }

    getOwnSessionId(): string | null {
        return this.ownSessionId;
    }

    /** Set the delivery mode for incoming inter-agent messages. */
    setDeliveryMode(mode: DeliveryMode): void {
        this.deliveryMode = mode;
    }

    getDeliveryMode(): DeliveryMode {
        return this.deliveryMode;
    }

    /**
     * Register a callback for immediate message injection.
     * Called by the remote extension with a function that calls pi.sendUserMessage().
     */
    onMessageReady(fn: MessageReadyCallback | null): void {
        this.messageReadyFn = fn;
    }

    /** Called by remote extension to wire up the status query path. */
    setStatusQueryFn(fn: StatusQueryFn | null): void {
        this.statusQueryFn = fn;
    }

    /** Emit a session_status_query and return true if dispatched. */
    sendStatusQuery(requestId: string, targetSessionId: string): boolean {
        if (!this.statusQueryFn) return false;
        return this.statusQueryFn(requestId, targetSessionId);
    }

    /** Called by remote extension when session_status_response arrives. */
    receiveStatusResponse(data: { requestId: string; status: unknown | null }): void {
        const listener = this.statusResponseListeners.get(data.requestId);
        if (listener) {
            this.statusResponseListeners.delete(data.requestId);
            listener(data);
        }
    }

    /** Register a one-shot listener for a status response with the given requestId. */
    onStatusResponse(requestId: string, listener: StatusResponseListener): void {
        this.statusResponseListeners.set(requestId, listener);
    }

    /** Remove a pending status response listener (e.g. on timeout). */
    removeStatusResponseListener(requestId: string): void {
        this.statusResponseListeners.delete(requestId);
    }

    /** Send a message to another session via the relay. Returns true if dispatched. */
    send(targetSessionId: string, message: string): boolean {
        if (!this.sendFn) return false;
        return this.sendFn(targetSessionId, message);
    }

    /** Called by remote extension when a session_message arrives from the relay. */
    receive(msg: SessionMessage): void {
        // Try to resolve a waiting promise first (backward-compatible for wait_for_message).
        for (let i = 0; i < this.waiters.length; i++) {
            const waiter = this.waiters[i];
            if (waiter.fromSessionId === null || waiter.fromSessionId === msg.fromSessionId) {
                this.waiters.splice(i, 1);
                waiter.resolve(msg);
                return;
            }
        }

        // No waiter matched — queue it.
        const key = msg.fromSessionId;
        if (!this.queues.has(key)) this.queues.set(key, []);
        this.queues.get(key)!.push(msg);
    }

    /**
     * Queue a completion message for auto-delivery.
     * Completion messages have higher priority than regular messages.
     */
    queueCompletion(msg: SessionMessage): void {
        this.completionQueue.push(msg);
    }

    /**
     * Queue a regular message for auto-delivery (used by queued/immediate modes).
     */
    queueAutoDelivery(msg: SessionMessage): void {
        this.autoDeliveryQueue.push(msg);
    }

    /**
     * Attempt immediate injection of a formatted message string.
     * Returns true if the message was injected via the callback, false otherwise.
     */
    tryImmediateDelivery(formattedMessage: string): boolean {
        if (this.messageReadyFn) {
            return this.messageReadyFn(formattedMessage);
        }
        return false;
    }

    /**
     * Drain all queued auto-delivery messages (completions first, then regular).
     * Returns formatted message strings ready for injection.
     */
    drainAutoDeliveryQueue(): string[] {
        const results: string[] = [];

        // Drain completions first (higher priority)
        for (const msg of this.completionQueue) {
            results.push(formatAgentMessage(msg.fromSessionId, "completion", msg.message));
        }
        this.completionQueue = [];

        // Then regular auto-delivery messages
        for (const msg of this.autoDeliveryQueue) {
            results.push(formatAgentMessage(msg.fromSessionId, "message", msg.message));
        }
        this.autoDeliveryQueue = [];

        return results;
    }

    /** Check if there are queued auto-delivery messages waiting. */
    hasQueuedAutoDelivery(): boolean {
        return this.completionQueue.length > 0 || this.autoDeliveryQueue.length > 0;
    }

    /**
     * Wait for the next message, optionally filtered by sender.
     * Resolves immediately if a matching message is already queued.
     */
    waitForMessage(
        fromSessionId: string | null,
        signal?: AbortSignal,
    ): Promise<SessionMessage | null> {
        // Check queues first.
        if (fromSessionId) {
            const q = this.queues.get(fromSessionId);
            if (q && q.length > 0) {
                return Promise.resolve(q.shift()!);
            }
        } else {
            // Any sender — grab the oldest message across all queues.
            let oldest: { key: string; msg: SessionMessage; idx: number } | null = null;
            for (const [key, q] of this.queues) {
                if (q.length > 0) {
                    const msg = q[0];
                    if (!oldest || msg.ts < oldest.msg.ts) {
                        oldest = { key, msg, idx: 0 };
                    }
                }
            }
            if (oldest) {
                this.queues.get(oldest.key)!.shift();
                return Promise.resolve(oldest.msg);
            }
        }

        // Nothing queued — register a waiter.
        if (signal?.aborted) return Promise.resolve(null);

        return new Promise<SessionMessage | null>((resolve) => {
            const waiter = { fromSessionId, resolve: resolve as MessageListener };
            this.waiters.push(waiter);

            if (signal) {
                const onAbort = () => {
                    const idx = this.waiters.indexOf(waiter);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    resolve(null);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }

    /** Drain all pending messages from a specific sender (or all). */
    drain(fromSessionId?: string): SessionMessage[] {
        if (fromSessionId) {
            const q = this.queues.get(fromSessionId) ?? [];
            this.queues.delete(fromSessionId);
            return q;
        }
        const all: SessionMessage[] = [];
        for (const [, q] of this.queues) all.push(...q);
        this.queues.clear();
        return all.sort((a, b) => a.ts.localeCompare(b.ts));
    }

    /** Get count of pending messages. */
    pendingCount(fromSessionId?: string): number {
        if (fromSessionId) {
            return this.queues.get(fromSessionId)?.length ?? 0;
        }
        let count = 0;
        for (const [, q] of this.queues) count += q.length;
        return count;
    }
}

/**
 * Format an inter-agent message with the standard prefix so agents can
 * distinguish it from human input.
 */
export function formatAgentMessage(fromSessionId: string, type: "completion" | "message", content: string): string {
    return `[AGENT_MESSAGE from=${fromSessionId} type=${type}]\n${content}`;
}

// Singleton instance shared between remote extension and messaging extension.
export const messageBus = new SessionMessageBus();
