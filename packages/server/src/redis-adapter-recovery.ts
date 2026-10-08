import type { Namespace, Server as SocketIOServer, Socket } from "socket.io";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis-adapter-recovery");
const recoverySockets = new WeakSet<object>();

export function markRedisAdapterRecoverySocket(socket: object): void {
    recoverySockets.add(socket);
}

export function unmarkRedisAdapterRecoverySocket(socket: object): void {
    recoverySockets.delete(socket);
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
        // No closeable transport: this socket will never actually reconnect
        // via the forced-close path, so the mark must not stick — its real
        // (unrelated) disconnect later must run normal teardown, not be
        // skipped as "recovery in progress".
        if (!conn || typeof conn.close !== "function") {
            unmarkRedisAdapterRecoverySocket(socket);
            continue;
        }
        if (seenConnections.has(conn)) continue;
        seenConnections.add(conn);
        try {
            conn.close(true);
            closed++;
        } catch (err) {
            log.warn(`failed to close transport during ${reason}:`, err);
            // conn.close() failing means NONE of this connection's sockets
            // will fire a real disconnect from this forced-close attempt.
            // Unmark every socket sharing this conn, not just the one that
            // threw — the others are already in seenConnections and would
            // otherwise `continue` past unmarked, stay marked indefinitely,
            // and have their eventual real disconnect skipped as "recovery
            // in progress" (the same zombie-entry class as the local socket
            // map bugs, just on the recovery-mark WeakSet instead).
            for (const other of entries) {
                if (other.socket.conn === conn) unmarkRedisAdapterRecoverySocket(other.socket);
            }
        }
    }
    return closed;
}

export interface LiveSocketRecoveryOptions {
    waitForSession?: (sessionId: string, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
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
 * Group viewer sockets by their underlying Engine.IO transport (conn), and
 * recover each transport independently: as soon as every TUI session that
 * conn is watching has its worker re-register (or that group's own timeout
 * elapses, whichever comes first), close that conn so its sockets reconnect
 * and resync.
 *
 * One Engine.IO connection can carry sockets from several namespaces at
 * once (e.g. the web UI opens /hub and /viewer on the same Manager, so both
 * ride one shared transport). Grouping by sessionId instead of by conn used
 * to be wrong here: a /hub socket has no sessionId, so it formed its own
 * `undefined` group and was closed immediately — which closes the SHARED
 * conn and drops the co-located /viewer socket before its worker has a
 * chance to re-register. Grouping by conn and waiting for every sessionId
 * carried on it keeps multiplexed sockets closing together, in sync with
 * the slowest session that conn is watching.
 *
 * Sockets whose conn carries no sessionId at all (e.g. not yet attached to
 * any session) have nothing to wait for and are closed immediately.
 *
 * Narrow known gap: a viewer socket mid-switch (viewer.ts clears
 * socket.data.sessionId before re-setting it to the new session) is
 * momentarily sessionId-less too, so it can be grouped with the no-sessionId
 * bucket and closed immediately instead of waiting for its NEW target
 * session's worker to re-register. The window is sub-millisecond (both lines
 * run synchronously in the same handler) and the socket simply reconnects
 * and resyncs like any other recovered viewer, so this is accepted as-is —
 * not treated as a bug.
 *
 * Grouping independently per conn (rather than waiting for every session
 * globally, then closing everything at once) means one slow-to-restart
 * worker cannot delay recovery for every other viewer, and a worker that
 * comes back late — after other sessions' viewers have already recovered —
 * still gets its own viewers reconnected promptly instead of waiting on a
 * shared clock.
 */
async function recoverViewerGroups(
    entries: RecoverySocket[],
    seenConnections: Set<object>,
    reason: string,
    opts: LiveSocketRecoveryOptions,
): Promise<void> {
    const timeoutMs = opts.viewerFallbackMs ?? 5_000;
    const connGroups = new Map<object, RecoverySocket[]>();
    const noConnEntries: RecoverySocket[] = [];
    for (const entry of entries) {
        const conn = entry.socket.conn as object | undefined;
        if (!conn) {
            noConnEntries.push(entry);
            continue;
        }
        const group = connGroups.get(conn);
        if (group) group.push(entry);
        else connGroups.set(conn, [entry]);
    }

    // No transport to group by — nothing to wait on, close right away.
    closeUniqueTransports(noConnEntries, seenConnections, reason);

    await Promise.all(
        Array.from(connGroups.values()).map(async (group) => {
            const sessionIds = new Set<string>();
            for (const { socket } of group) {
                const sessionId = sessionIdOf(socket);
                if (sessionId) sessionIds.add(sessionId);
            }
            if (sessionIds.size > 0 && opts.waitForSession) {
                await Promise.all(
                    Array.from(sessionIds, (sessionId) =>
                        opts.waitForSession!(sessionId, timeoutMs, opts.signal).catch((err) => {
                            log.warn(`viewer recovery wait failed for session ${sessionId} during ${reason}:`, err);
                            return false;
                        }),
                    ),
                );
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
