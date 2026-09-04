import { useEffect, useCallback, useRef, useState } from "react";
import { useViewerSocket, type ViewerSocket } from "@/lib/viewer-socket-context";
import type { ServiceAnnounceData, ServiceEnvelope } from "@pizzapi/protocol";

// Re-export so existing consumers that import from this module still work.
export { getEagerServiceAvailability } from "./service-availability";
import { getEagerServiceAvailability } from "./service-availability";

export interface ServiceChannelOptions<TPayload = unknown> {
    onMessage?: (type: string, payload: TPayload, requestId?: string, sessionId?: string) => void;
    /**
     * Pin the channel to a specific runner/session instead of the
     * currently-viewed one (runner-scoped panels, e.g. traveling tunnel tabs).
     * - `send` stamps `runnerId`/`sessionId` so the relay routes to the pinned
     *   runner (ownership-validated server-side).
     * - The socket joins the runner's service follow room, so events for the
     *   pinned session keep arriving while viewing another runner.
     */
    target?: { runnerId?: string; sessionId?: string };
}

interface FollowEntry {
    serviceId: string;
    runnerId: string;
    count: number;
    joined: boolean;
    joining: boolean;
    generation: number;
    listeners: Set<(ready: boolean) => void>;
}

interface SocketFollowState {
    entries: Map<string, FollowEntry>;
    onConnect: () => void;
}

const followStates = new WeakMap<ViewerSocket, SocketFollowState>();

function followKey(serviceId: string, runnerId: string): string {
    return `${serviceId}\0${runnerId}`;
}

function emitFollow(socket: ViewerSocket, state: SocketFollowState, entry: FollowEntry): void {
    if (entry.joining || entry.count === 0) return;
    entry.joining = true;
    const generation = ++entry.generation;
    socket.emit("service_follow", { serviceId: entry.serviceId, runnerId: entry.runnerId }, (ok: boolean) => {
        entry.joining = false;
        const current = state.entries.get(followKey(entry.serviceId, entry.runnerId));
        if (current !== entry || entry.count === 0) {
            if (ok) socket.emit("service_unfollow", { serviceId: entry.serviceId, runnerId: entry.runnerId });
            return;
        }
        if (entry.generation !== generation) return;
        entry.joined = ok;
        for (const listener of entry.listeners) listener(ok);
    });
}

function getFollowState(socket: ViewerSocket): SocketFollowState {
    const existing = followStates.get(socket);
    if (existing) return existing;
    const state: SocketFollowState = {
        entries: new Map(),
        onConnect: () => {
            for (const entry of state.entries.values()) {
                entry.joined = false;
                entry.joining = false;
                for (const listener of entry.listeners) listener(false);
                emitFollow(socket, state, entry);
            }
        },
    };
    followStates.set(socket, state);
    socket.on("connect", state.onConnect);
    return state;
}

/**
 * Reference-count a follow room per socket. Several mounted tunnel panels may
 * share one Socket.IO room; only the final unmount leaves it. Reconnects rejoin
 * every active room and invalidate acknowledgements from the old connection.
 */
function acquireServiceFollow(
    socket: ViewerSocket,
    serviceId: string,
    runnerId: string,
    onReady: (ready: boolean) => void,
): () => void {
    const state = getFollowState(socket);
    const key = followKey(serviceId, runnerId);
    let entry = state.entries.get(key);
    if (!entry) {
        entry = { serviceId, runnerId, count: 0, joined: false, joining: false, generation: 0, listeners: new Set() };
        state.entries.set(key, entry);
    }
    entry.count++;
    entry.listeners.add(onReady);
    onReady(entry.joined);
    emitFollow(socket, state, entry);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        entry!.listeners.delete(onReady);
        entry!.count--;
        if (entry!.count > 0) return;
        entry!.generation++;
        if (entry!.joined) socket.emit("service_unfollow", { serviceId, runnerId });
        state.entries.delete(key);
        if (state.entries.size === 0) {
            socket.off("connect", state.onConnect);
            followStates.delete(socket);
        }
    };
}

export interface ServiceChannel<TSend = unknown> {
    send: (type: string, payload: TSend, requestId?: string) => void;
    available: boolean;
    /** Whether a targeted service follow room has finished joining. */
    ready: boolean;
}

export function useServiceChannel<TSend = unknown, TPayload = unknown>(
    serviceId: string,
    options: ServiceChannelOptions<TPayload> = {}
): ServiceChannel<TSend> {
    const socket = useViewerSocket();
    const [available, setAvailable] = useState(() => getEagerServiceAvailability(socket, serviceId));
    const [ready, setReady] = useState(() => !options.target?.runnerId);
    const onMessageRef = useRef(options.onMessage);
    onMessageRef.current = options.onMessage;
    const targetRef = useRef(options.target);
    targetRef.current = options.target;
    const targetRunnerId = options.target?.runnerId;

    useEffect(() => {
        if (!socket) {
            setAvailable(false);
            setReady(false);
            return;
        }

        setReady(!targetRunnerId);
        setAvailable(getEagerServiceAvailability(socket, serviceId));

        const handleMessage = (envelope: ServiceEnvelope) => {
            if (envelope.serviceId !== serviceId) return;
            // Targeted channels only accept runner-level events (no sessionId)
            // and events for their pinned session — other sessions on the same
            // runner share the follow room but are not this panel's business.
            // Handlers are idempotent, so the duplicate delivery that occurs
            // when the pinned session IS the viewed session (session room +
            // follow room) is harmless.
            // ponytail: filter by sessionId only; add requestId matching if a
            // service ever needs cross-session responses in the follow room.
            const target = targetRef.current;
            if (target?.runnerId) {
                if (envelope.sessionId) {
                    if (envelope.sessionId !== target.sessionId) return;
                } else if (envelope.sourceRunnerId !== target.runnerId) {
                    // Sessionless events only come from the follow room; require
                    // the server-stamped source runner to prevent runner A's
                    // broadcast from mutating runner B's panel.
                    return;
                }
            }
            onMessageRef.current?.(envelope.type, envelope.payload as TPayload, envelope.requestId, envelope.sessionId);
        };

        const handleAnnounce = (data: ServiceAnnounceData) => {
            setAvailable(data.serviceIds.includes(serviceId));
        };

        // NOTE: No handleDisconnect listener — we intentionally preserve
        // the previous `available` state when the socket disconnects during
        // a session switch. The old socket fires `disconnect` synchronously
        // before the new socket is set, which would flash available to false
        // and cause TunnelPanel to show "unavailable" briefly. Instead, we
        // only set available=false when the effect re-runs with socket===null
        // (handled above), and the new socket's service_announce will update
        // availability once it arrives.
        //
        // On reconnect (socket.io auto-reconnect within the same socket
        // instance), the server re-sends service_announce which updates
        // availability via handleAnnounce.

        socket.on("service_message", handleMessage);
        socket.on("service_announce", handleAnnounce);

        // Runner-scoped channels follow their runner's service events so they
        // keep receiving them while the viewer watches a session elsewhere.
        // Ownership is validated server-side on join.
        const releaseFollow = targetRunnerId
            ? acquireServiceFollow(socket, serviceId, targetRunnerId, setReady)
            : undefined;

        return () => {
            releaseFollow?.();
            setReady(false);
            socket.off("service_message", handleMessage);
            socket.off("service_announce", handleAnnounce);
        };
    }, [socket, serviceId, targetRunnerId]);

    /**
     * Send a message to the service.
     *
     * **Important:** Only call `send` when `available === true`. The socket
     * may be disconnected or the service may not yet be registered when
     * `available` is `false`, so any message sent in that state will be
     * silently dropped. Consumers should gate all calls behind `if (available)`.
     */
    const send = useCallback((type: string, payload: TSend, requestId?: string) => {
        if (!socket) return;
        const target = targetRef.current;
        if (target?.runnerId && !ready) return;
        const envelope: ServiceEnvelope = {
            serviceId,
            type,
            payload,
            requestId,
            ...(target?.runnerId ? { runnerId: target.runnerId } : {}),
            ...(target?.sessionId ? { sessionId: target.sessionId } : {}),
        };
        socket.emit("service_message", envelope);
    }, [socket, serviceId, ready]);

    return { send, available, ready };
}
