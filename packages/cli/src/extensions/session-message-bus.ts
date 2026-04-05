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

type MessageListener = (msg: SessionMessage | null) => void;

/** Callback used by the bus to actually send a message over the relay WebSocket. */
type SendFn = (targetSessionId: string, message: string) => boolean;

const MAX_QUEUED_MESSAGES_PER_SESSION = 100;
const MAX_TRACKED_CONSUMED_SESSIONS = 1000;

export class SessionMessageBus {
    /** Queued incoming messages, keyed by fromSessionId. */
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
    /**
     * Session IDs from which this parent has consumed at least one message
     * via waitForMessage or drain. Used to auto-ack redundant session_complete
     * triggers when the parent already processed the child's output via messages.
     */
    private consumedSessions = new Set<string>();
    /** FIFO order for consumed session tracking so old entries can be evicted. */
    private consumedSessionOrder: string[] = [];

    private markConsumed(sessionId: string): void {
        if (this.consumedSessions.has(sessionId)) return;
        this.consumedSessions.add(sessionId);
        this.consumedSessionOrder.push(sessionId);
        while (this.consumedSessionOrder.length > MAX_TRACKED_CONSUMED_SESSIONS) {
            const oldest = this.consumedSessionOrder.shift();
            if (oldest) this.consumedSessions.delete(oldest);
        }
    }

    private resetForNewSession(): void {
        this.queues.clear();
        for (const waiter of this.waiters) {
            waiter.resolve(null);
        }
        this.waiters = [];
        this.consumedSessions.clear();
        this.consumedSessionOrder = [];
    }

    /** Called by remote extension to wire up the send path. */
    setSendFn(fn: SendFn | null): void {
        this.sendFn = fn;
    }

    /** Called by remote extension after relay registration. */
    setOwnSessionId(id: string): void {
        if (this.ownSessionId && this.ownSessionId !== id) {
            this.resetForNewSession();
        }
        this.ownSessionId = id;
    }

    getOwnSessionId(): string | null {
        return this.ownSessionId;
    }

    /** Send a message to another session via the relay. Returns true if dispatched. */
    send(targetSessionId: string, message: string): boolean {
        if (!this.sendFn) return false;
        return this.sendFn(targetSessionId, message);
    }

    /** Called by remote extension when a session_message arrives from the relay. */
    receive(msg: SessionMessage): void {
        // Try to resolve a waiting promise first.
        for (let i = 0; i < this.waiters.length; i++) {
            const waiter = this.waiters[i];
            if (waiter.fromSessionId === null || waiter.fromSessionId === msg.fromSessionId) {
                this.waiters.splice(i, 1);
                this.markConsumed(msg.fromSessionId);
                waiter.resolve(msg);
                return;
            }
        }

        // No waiter matched — queue it, but cap queue growth per sender.
        const key = msg.fromSessionId;
        if (!this.queues.has(key)) this.queues.set(key, []);
        const queue = this.queues.get(key)!;
        if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
            queue.shift();
        }
        queue.push(msg);
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
                const msg = q.shift()!;
                this.markConsumed(msg.fromSessionId);
                return Promise.resolve(msg);
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
                this.markConsumed(oldest.msg.fromSessionId);
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
            if (q.length > 0) this.markConsumed(fromSessionId);
            this.queues.delete(fromSessionId);
            return q;
        }
        const all: SessionMessage[] = [];
        for (const [key, q] of this.queues) {
            if (q.length > 0) this.markConsumed(key);
            all.push(...q);
        }
        this.queues.clear();
        return all.sort((a, b) => a.ts.localeCompare(b.ts));
    }

    /** Returns true if this parent has consumed at least one message from the given session. */
    hasConsumedMessagesFrom(sessionId: string): boolean {
        return this.consumedSessions.has(sessionId);
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

    /** Test helper: reset singleton state between tests. */
    resetForTests(): void {
        this.sendFn = null;
        this.ownSessionId = null;
        this.resetForNewSession();
    }
}

// Singleton instance shared between remote extension and messaging extension.
export const messageBus = new SessionMessageBus();
