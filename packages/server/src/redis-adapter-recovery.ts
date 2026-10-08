import type { Namespace, Server as SocketIOServer, Socket } from "socket.io";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis-adapter-recovery");
const recoverySockets = new WeakSet<object>();

export function markRedisAdapterRecoverySocket(socket: object): void {
    recoverySockets.add(socket);
}

export function isRedisAdapterRecoverySocket(socket: object | null | undefined): boolean {
    return !!socket && recoverySockets.has(socket);
}

export interface RedisAdapterRecoveryController {
    redisReady(side: "pub" | "sub"): void;
    redisDegraded(side: "pub" | "sub"): void;
}

export interface RedisAdapterRecoveryOptions {
    initialPubReady: boolean;
    initialSubReady: boolean;
    recover?: (reason: string) => void;
    cancelRecovery?: () => void;
}

export function createRedisAdapterRecoveryController(
    opts: RedisAdapterRecoveryOptions,
): RedisAdapterRecoveryController {
    let pubReady = opts.initialPubReady;
    let subReady = opts.initialSubReady;
    let hasReachedReady = pubReady && subReady;
    let needsRecovery = false;

    const recover = opts.recover ?? (() => {});

    function maybeRecover(): void {
        if (!pubReady || !subReady) return;
        if (!hasReachedReady) {
            hasReachedReady = true;
            return;
        }
        if (!needsRecovery) return;
        needsRecovery = false;
        recover("redis-adapter-reconnected");
    }

    return {
        redisReady(side) {
            if (side === "pub") pubReady = true;
            else subReady = true;
            maybeRecover();
        },
        redisDegraded(side) {
            if (side === "pub") pubReady = false;
            else subReady = false;
            if (hasReachedReady) {
                needsRecovery = true;
                opts.cancelRecovery?.();
            }
        },
    };
}

interface RecoverySocket {
    namespace: string;
    socket: Socket;
}

function liveNamespaceSockets(io: SocketIOServer): RecoverySocket[] {
    const nsps = (io as unknown as { _nsps?: Map<string, Namespace> })._nsps;
    const namespaces = nsps ? Array.from(nsps.values()) : [io.of("/relay"), io.of("/runner")];
    const sockets: RecoverySocket[] = [];
    for (const nsp of namespaces) {
        for (const socket of nsp.sockets.values() as Iterable<Socket>) {
            if (socket.connected) sockets.push({ namespace: nsp.name, socket });
        }
    }
    return sockets;
}

function closeUniqueTransports(entries: RecoverySocket[], seenConnections: Set<object>, reason: string): number {
    let closed = 0;
    for (const { socket } of entries) {
        const conn = socket.conn as { close?: (discard?: boolean) => void } | undefined;
        if (!conn || typeof conn.close !== "function") continue;
        if (seenConnections.has(conn)) continue;
        seenConnections.add(conn);
        try {
            conn.close(true);
            closed++;
        } catch (err) {
            log.warn(`failed to close transport during ${reason}:`, err);
        }
    }
    return closed;
}

export interface LiveSocketRecoveryOptions {
    waitForSession?: (sessionId: string, timeoutMs: number) => Promise<boolean>;
    viewerFallbackMs?: number;
    signal?: AbortSignal;
    shouldCancel?: () => boolean;
}

function uniqueTransportCount(entries: RecoverySocket[]): number {
    const seen = new Set<object>();
    for (const { socket } of entries) {
        const conn = socket.conn as object | undefined;
        if (conn) seen.add(conn);
    }
    return seen.size;
}

function sessionIdOf(socket: Socket): string | undefined {
    const sessionId = (socket.data as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Group viewer transports by the TUI session they are watching, and recover
 * each group independently: as soon as that session's worker re-registers
 * (or that group's own timeout elapses, whichever comes first), close just
 * that group's transports so those viewers reconnect and resync.
 *
 * Viewers with no resolvable sessionId (e.g. not yet attached to a session)
 * have nothing to wait for and are closed immediately.
 *
 * Grouping independently (rather than waiting for every session globally,
 * then closing everything at once) means one slow-to-restart worker cannot
 * delay recovery for every other viewer, and a worker that comes back late
 * — after other sessions' viewers have already recovered — still gets its
 * own viewers reconnected promptly instead of waiting on a shared clock.
 */
async function recoverViewerGroups(
    entries: RecoverySocket[],
    seenConnections: Set<object>,
    reason: string,
    opts: LiveSocketRecoveryOptions,
): Promise<void> {
    const timeoutMs = opts.viewerFallbackMs ?? 5_000;
    const groups = new Map<string | undefined, RecoverySocket[]>();
    for (const entry of entries) {
        const key = sessionIdOf(entry.socket);
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
    }

    await Promise.all(
        Array.from(groups.entries()).map(async ([sessionId, group]) => {
            if (sessionId && opts.waitForSession) {
                await opts.waitForSession(sessionId, timeoutMs).catch((err) => {
                    log.warn(`viewer recovery wait failed for session ${sessionId} during ${reason}:`, err);
                    return false;
                });
            }
            if (opts.signal?.aborted || opts.shouldCancel?.()) return;
            closeUniqueTransports(group, seenConnections, reason);
        }),
    );
}

export function recoverLiveSocketsAfterRedisReconnect(
    io: SocketIOServer,
    reason: string,
    opts: LiveSocketRecoveryOptions = {},
): number {
    const sockets = liveNamespaceSockets(io);

    // Mark every namespace socket before closing any underlying Engine.IO
    // transport. One transport can carry multiple namespace sockets; close()
    // may synchronously fire disconnect handlers for all of them.
    for (const { socket } of sockets) markRedisAdapterRecoverySocket(socket);

    const seenConnections = new Set<object>();
    const core = sockets.filter(({ namespace }) => namespace === "/relay" || namespace === "/runner");
    const rest = sockets.filter(({ namespace }) => namespace !== "/relay" && namespace !== "/runner");
    const planned = uniqueTransportCount(sockets);
    closeUniqueTransports(core, seenConnections, reason);
    if (rest.length > 0) {
        void recoverViewerGroups(rest, seenConnections, reason, opts).catch((err) => {
            log.warn(`viewer recovery failed during ${reason}:`, err);
        });
    }

    if (planned > 0) {
        log.warn(`Redis adapter recovered after outage; forced ${planned} live transport(s) to reconnect`);
    }
    return planned;
}
