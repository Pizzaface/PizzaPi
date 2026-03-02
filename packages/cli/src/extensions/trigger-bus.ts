/**
 * Conversation trigger bus.
 *
 * Singleton that mediates trigger registration/cancellation/listing between
 * the agent tools and the relay WebSocket connection. The remote extension
 * provides the send callbacks; the conversation-triggers extension's tools
 * call the bus methods which resolve when server acks arrive.
 */

import type { TriggerType, TriggerConfig, TriggerDelivery, TriggerRecord } from "@pizzapi/protocol";

export interface RegisterTriggerParams {
    type: TriggerType;
    config: TriggerConfig;
    delivery?: TriggerDelivery;
    message?: string;
    maxFirings?: number;
    expiresAt?: string;
}

/** Callback types used by the bus to send requests over the relay WebSocket. */
type RegisterFn = (params: RegisterTriggerParams) => boolean;
type CancelFn = (triggerId: string) => boolean;
type ListFn = () => boolean;
type EmitFn = (eventName: string, payload?: unknown) => boolean;

const TIMEOUT_MS = 10_000;

class TriggerBus {
    /** Wire-up callbacks set by remote.ts when relay socket connects. */
    private registerFn: RegisterFn | null = null;
    private cancelFn: CancelFn | null = null;
    private listFn: ListFn | null = null;
    private emitFn: EmitFn | null = null;

    /** Pending register_trigger promises. */
    private pendingRegister: Array<{
        resolve: (data: { triggerId: string; type: TriggerType }) => void;
        reject: (err: Error) => void;
    }> = [];

    /** Pending cancel_trigger promises, keyed by triggerId for matching. */
    private pendingCancel: Array<{
        triggerId: string;
        resolve: (data: { triggerId: string }) => void;
        reject: (err: Error) => void;
    }> = [];

    /** Pending list_triggers promises. */
    private pendingList: Array<{
        resolve: (data: { triggers: TriggerRecord[] }) => void;
        reject: (err: Error) => void;
    }> = [];

    // ── Setters (called by remote.ts) ──────────────────────────────────────

    setRegisterFn(fn: RegisterFn | null): void {
        this.registerFn = fn;
    }

    setCancelFn(fn: CancelFn | null): void {
        this.cancelFn = fn;
    }

    setListFn(fn: ListFn | null): void {
        this.listFn = fn;
    }

    setEmitFn(fn: EmitFn | null): void {
        this.emitFn = fn;
    }

    // ── Tool-facing methods ────────────────────────────────────────────────

    /** Register a new trigger. Returns a promise that resolves when the server acks. */
    register(params: RegisterTriggerParams): Promise<{ triggerId: string; type: TriggerType }> {
        if (!this.registerFn) {
            return Promise.reject(new Error("Not connected to relay. Cannot register triggers without a relay connection."));
        }

        const sent = this.registerFn(params);
        if (!sent) {
            return Promise.reject(new Error("Failed to send register_trigger to relay."));
        }

        return new Promise<{ triggerId: string; type: TriggerType }>((resolve, reject) => {
            const entry = { resolve, reject };
            this.pendingRegister.push(entry);

            const timer = setTimeout(() => {
                const idx = this.pendingRegister.indexOf(entry);
                if (idx !== -1) {
                    this.pendingRegister.splice(idx, 1);
                    reject(new Error("Timed out waiting for trigger registration ack from server."));
                }
            }, TIMEOUT_MS);

            // Wrap resolve/reject to clear the timer.
            const origResolve = entry.resolve;
            const origReject = entry.reject;
            entry.resolve = (data) => { clearTimeout(timer); origResolve(data); };
            entry.reject = (err) => { clearTimeout(timer); origReject(err); };
        });
    }

    /** Cancel an existing trigger. Returns a promise that resolves when the server acks. */
    cancel(triggerId: string): Promise<{ triggerId: string }> {
        if (!this.cancelFn) {
            return Promise.reject(new Error("Not connected to relay. Cannot cancel triggers without a relay connection."));
        }

        const sent = this.cancelFn(triggerId);
        if (!sent) {
            return Promise.reject(new Error("Failed to send cancel_trigger to relay."));
        }

        return new Promise<{ triggerId: string }>((resolve, reject) => {
            const entry = { triggerId, resolve, reject };
            this.pendingCancel.push(entry);

            const timer = setTimeout(() => {
                const idx = this.pendingCancel.indexOf(entry);
                if (idx !== -1) {
                    this.pendingCancel.splice(idx, 1);
                    reject(new Error(`Timed out waiting for cancel ack for trigger ${triggerId}.`));
                }
            }, TIMEOUT_MS);

            const origResolve = entry.resolve;
            const origReject = entry.reject;
            entry.resolve = (data) => { clearTimeout(timer); origResolve(data); };
            entry.reject = (err) => { clearTimeout(timer); origReject(err); };
        });
    }

    /** List all active triggers. Returns a promise that resolves with the list. */
    list(): Promise<{ triggers: TriggerRecord[] }> {
        if (!this.listFn) {
            return Promise.reject(new Error("Not connected to relay. Cannot list triggers without a relay connection."));
        }

        const sent = this.listFn();
        if (!sent) {
            return Promise.reject(new Error("Failed to send list_triggers to relay."));
        }

        return new Promise<{ triggers: TriggerRecord[] }>((resolve, reject) => {
            const entry = { resolve, reject };
            this.pendingList.push(entry);

            const timer = setTimeout(() => {
                const idx = this.pendingList.indexOf(entry);
                if (idx !== -1) {
                    this.pendingList.splice(idx, 1);
                    reject(new Error("Timed out waiting for trigger list from server."));
                }
            }, TIMEOUT_MS);

            const origResolve = entry.resolve;
            const origReject = entry.reject;
            entry.resolve = (data) => { clearTimeout(timer); origResolve(data); };
            entry.reject = (err) => { clearTimeout(timer); origReject(err); };
        });
    }

    /**
     * Emit a custom event for pub/sub coordination. Fire-and-forget.
     * Returns true if the event was dispatched to the relay.
     */
    emit(eventName: string, payload?: unknown): boolean {
        if (!this.emitFn) return false;
        return this.emitFn(eventName, payload);
    }

    // ── Server ack handlers (called by remote.ts) ──────────────────────────

    /** Called when the server confirms a trigger was registered. */
    onRegistered(data: { triggerId: string; type: TriggerType }): void {
        const entry = this.pendingRegister.shift();
        if (entry) {
            entry.resolve(data);
        }
    }

    /** Called when the server confirms a trigger was cancelled. */
    onCancelled(data: { triggerId: string }): void {
        // Match by triggerId if available, otherwise take the oldest pending.
        const idx = this.pendingCancel.findIndex((e) => e.triggerId === data.triggerId);
        if (idx !== -1) {
            const [entry] = this.pendingCancel.splice(idx, 1);
            entry.resolve(data);
        } else if (this.pendingCancel.length > 0) {
            const entry = this.pendingCancel.shift()!;
            entry.resolve(data);
        }
    }

    /** Called when the server returns the trigger list. */
    onList(data: { triggers: TriggerRecord[] }): void {
        const entry = this.pendingList.shift();
        if (entry) {
            entry.resolve(data);
        }
    }

    /** Called when the server returns a trigger-related error. */
    onError(data: { message: string; triggerId?: string }): void {
        const err = new Error(data.message);

        // If a triggerId is provided, try to match a pending cancel first.
        if (data.triggerId) {
            const idx = this.pendingCancel.findIndex((e) => e.triggerId === data.triggerId);
            if (idx !== -1) {
                const [entry] = this.pendingCancel.splice(idx, 1);
                entry.reject(err);
                return;
            }
        }

        // Otherwise reject the oldest pending operation (register → cancel → list priority).
        if (this.pendingRegister.length > 0) {
            this.pendingRegister.shift()!.reject(err);
        } else if (this.pendingCancel.length > 0) {
            this.pendingCancel.shift()!.reject(err);
        } else if (this.pendingList.length > 0) {
            this.pendingList.shift()!.reject(err);
        }
    }
}

/** Singleton instance shared between remote extension and conversation-triggers extension. */
export const triggerBus = new TriggerBus();
