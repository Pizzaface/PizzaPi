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

type MessageListener = (msg: SessionMessage) => void;

/** Callback used by the bus to actually send a message over the relay WebSocket. */
type SendFn = (targetSessionId: string, message: string) => boolean;

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

// Singleton instance shared between remote extension and messaging extension.
export const messageBus = new SessionMessageBus();
