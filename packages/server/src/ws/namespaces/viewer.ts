// ============================================================================
// /viewer namespace — Browser viewer ↔ Server
//
// Handles viewer connection to sessions, snapshot replay for disconnected
// sessions, collab-mode input/model/exec forwarding to the TUI socket,
// and resync requests.
// ============================================================================

import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import { bindAuthContext, type AuthContext } from "../../auth.js";
import type {
    ViewerClientToServerEvents,
    ViewerServerToClientEvents,
    ViewerInterServerEvents,
    ViewerSocketData,
} from "@pizzapi/protocol";

// Inline definition mirrors packages/protocol/src/shared.ts ServiceEnvelope.
// Using a local alias avoids a cross-worktree symlink resolution issue where
// node_modules/@pizzapi/protocol points to the main branch's dist, not this
// worktree's updated dist.
type ServiceEnvelope = { serviceId: string; type: string; requestId?: string; payload: unknown };
import { browserAuthMiddleware } from "./auth.js";
import { bindSocketHandlersToAuthContext } from "./context.js";
import { getRunnerServiceAnnounce } from "./runner.js";
import { withRunnerRefHint } from "./runner-ref.js";
import {
    getSharedSession,
    getSharedSessionSummary,
    addViewer,
    removeViewer,
    getSessionSeq,
    sendSnapshotToViewer,
    getLocalTuiSocket,
    emitToRelaySession,
    emitToRelaySessionVerified,
    emitToRelaySessionChecked,
    type RelayEmitCheckResult,
    emitToRunner,
    broadcastToSessionViewers,
    markPendingRecovery,
} from "../sio-registry.js";
import { isChildOfParent } from "../sio-state/index.js";
import { getPendingChunkedSnapshot } from "./relay/index.js";
import { getLatestCachedSnapshotEvent } from "../../sessions/redis.js";
import { getPersistedRelaySessionSnapshot } from "../../sessions/store.js";
import { recordTriggerResponse } from "../../sessions/trigger-store.js";
import { getHiddenModels } from "../../user-hidden-models.js";
import { isHiddenModel } from "../../routes/model-guard.js";
import { createLogger } from "@pizzapi/tools";
import { hydrateViewerFromCache, sendCachedDeltaReplayEvents } from "./viewer-cache.js";
import { getBestSnapshot } from "./snapshot-provider.js";

export { hydrateViewerFromCache, sendCachedDeltaReplayEvents } from "./viewer-cache.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createLogger("sio/viewer");

type ViewerSocket = Socket<
    ViewerClientToServerEvents,
    ViewerServerToClientEvents,
    ViewerInterServerEvents,
    ViewerSocketData
>;

interface AgentEndEvent extends Record<string, unknown> {
    type: "agent_end";
    messages: unknown[];
}

interface SessionActiveEvent extends Record<string, unknown> {
    type: "session_active";
    state: unknown;
}

/** @internal — exported for unit tests only */
export function isAgentEndEvent(evt: unknown): evt is AgentEndEvent {
    return (
        typeof evt === "object" &&
        evt !== null &&
        "type" in evt &&
        evt.type === "agent_end" &&
        "messages" in evt &&
        Array.isArray((evt as AgentEndEvent).messages)
    );
}

/** @internal — exported for unit tests only */
export function isSessionActiveEvent(evt: unknown): evt is SessionActiveEvent {
    return (
        typeof evt === "object" &&
        evt !== null &&
        "type" in evt &&
        evt.type === "session_active" &&
        "state" in evt &&
        (evt as SessionActiveEvent).state !== undefined
    );
}

/**
 * Scan cached events from newest to oldest, looking for the latest
 * full-state snapshot (agent_end with messages, or session_active with state).
 * @internal — exported for unit tests only
 */
export function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (isAgentEndEvent(raw)) return raw;
        if (isSessionActiveEvent(raw)) return raw;
    }
    return null;
}

/** @internal — exported for unit tests only */
export function onViewerConnectedSignal(
    viewerReadyForRunnerSignal: boolean,
    pendingConnectedSignal: boolean,
): { pendingConnectedSignal: boolean; forwardNow: boolean } {
    if (viewerReadyForRunnerSignal) {
        return { pendingConnectedSignal: false, forwardNow: true };
    }
    return { pendingConnectedSignal: true, forwardNow: false };
}

/** @internal — exported for unit tests only */
export function onViewerReadyForRunnerSignal(
    pendingConnectedSignal: boolean,
): { pendingConnectedSignal: boolean; forwardNow: boolean } {
    if (!pendingConnectedSignal) {
        return { pendingConnectedSignal: false, forwardNow: false };
    }
    return { pendingConnectedSignal: false, forwardNow: true };
}

/** @internal — exported for unit tests only */
export function withHubMetaSource<T extends Record<string, unknown>>(payload: T): T & { meta_source: "hub" } {
    return { ...payload, meta_source: "hub" };
}

/** @internal — exported for unit tests only */
export function withLivenessOnlyHint<T extends Record<string, unknown>>(event: T): T & { _livenessOnly: true } {
    return { ...event, _livenessOnly: true };
}

/** @internal — exported for unit tests only */
export function shouldAvoidSnapshotFallback(requestedLastSeq: number | undefined, pending: unknown): boolean {
    return requestedLastSeq !== undefined || (pending !== null && pending !== undefined);
}

/** @internal — exported for unit tests only */
export function isViewerSwitchCurrent(currentGeneration: number | undefined, requestedGeneration?: number): boolean {
    return requestedGeneration === undefined || currentGeneration === requestedGeneration;
}

// ponytail: 256 KB cap per envelope; raise if legitimate runner services prove they need bigger payloads
const MAX_SERVICE_MESSAGE_BYTES = 256 * 1024;
// ponytail: 50 forwards/second per socket; upgrade to a token bucket if services legitimately burst higher
const MAX_SERVICE_MESSAGE_PER_SECOND = 50;
const SERVICE_MESSAGE_RATE_WINDOW_MS = 1000;

interface ServiceMessageRateLimitState {
    count: number;
    resetAt: number;
}

/** @internal — exported for unit tests only */
export function checkServiceMessageSize(
    envelope: ServiceEnvelope,
): { ok: true; bytes: number } | { ok: false; reason: string; bytes: number } {
    try {
        const serialized = JSON.stringify(envelope);
        const bytes = Buffer.byteLength(serialized);
        if (bytes > MAX_SERVICE_MESSAGE_BYTES) {
            return {
                ok: false,
                reason: `service_message payload exceeds ${MAX_SERVICE_MESSAGE_BYTES} bytes`,
                bytes,
            };
        }
        return { ok: true, bytes };
    } catch {
        return { ok: false, reason: "service_message payload is not JSON-serializable", bytes: 0 };
    }
}

/** @internal — exported for unit tests only */
export function checkServiceMessageRateLimit(
    now: number,
    state: ServiceMessageRateLimitState,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
    if (now >= state.resetAt) {
        state.count = 0;
        state.resetAt = now + SERVICE_MESSAGE_RATE_WINDOW_MS;
    }
    if (state.count >= MAX_SERVICE_MESSAGE_PER_SECOND) {
        return { allowed: false, retryAfterMs: state.resetAt - now };
    }
    state.count++;
    return { allowed: true };
}

export interface RecoveryConnectedSignalDeps {
    markPendingRecovery: typeof markPendingRecovery;
    emitToRelaySessionChecked: typeof emitToRelaySessionChecked;
}

const defaultRecoveryConnectedSignalDeps: RecoveryConnectedSignalDeps = {
    markPendingRecovery,
    emitToRelaySessionChecked,
};

/**
 * Ask the runner to rebuild and re-emit a fresh session_active.
 *
 * Verified: this signal is the LAST fallback tier — every cache tier has
 * already declined — so firing it into an empty room (offline/hung runner)
 * with a fire-and-forget emit left the viewer silently spinning for the full
 * client watchdog window. Returns false when no runner socket is in the room
 * so callers can tell the viewer the truth instead.
 *
 * @internal — exported for unit tests only
 */
export async function forwardRecoveryConnectedSignal(
    sessionId: string,
    deps: RecoveryConnectedSignalDeps = defaultRecoveryConnectedSignalDeps,
): Promise<RelayEmitCheckResult> {
    const recoveryNonce = deps.markPendingRecovery(sessionId);
    // The runner echoes recoveryNonce on its recovery session_active so the
    // event pipeline can distinguish it from real agent updates racing in.
    const result = await deps.emitToRelaySessionChecked(sessionId, "connected" as string, { recoveryNonce });
    if (result === "empty") {
        log.warn(`recovery signal for ${sessionId}: room confirmed empty — runner offline or hung`);
    } else if (result === "unknown") {
        log.warn(`recovery signal for ${sessionId}: adapter lookup failed — runner state unknown, leaving recovery to client retry`);
    }
    return result;
}

/**
 * Heartbeats arrive every ~10s from a healthy runner; this many missed beats
 * means the runner is offline or hung regardless of what isActive says.
 */
const RUNNER_HEARTBEAT_STALE_MS = 45_000;

/** @internal — exported for unit tests only */
export function runnerLooksLive(session: { isActive?: boolean; lastHeartbeatAt?: string | null }): boolean {
    if (!session.isActive) return false;
    if (typeof session.lastHeartbeatAt !== "string" || !session.lastHeartbeatAt) return false;
    const at = Date.parse(session.lastHeartbeatAt);
    return Number.isFinite(at) && Date.now() - at < RUNNER_HEARTBEAT_STALE_MS;
}

/**
 * Fire the recovery signal and, when it provably reached no runner, tell the
 * viewer instead of leaving it awaiting a snapshot that cannot arrive.
 */
function forwardRecoverySignalOrNotify(
    sessionId: string,
    socket: ViewerSocket,
    generation: number | undefined,
    onConfirmedOffline?: () => Promise<void>,
): void {
    void forwardRecoveryConnectedSignal(sessionId).then(async (result) => {
        // "unknown" (Redis-degraded lookup) is NOT proof the runner is gone —
        // it may be connected on another node. Do nothing; client retry covers it.
        if (result !== "empty") return;
        if (socket.data.sessionId !== sessionId) return; // viewer moved on
        if (onConfirmedOffline) {
            await onConfirmedOffline();
            return;
        }
        socket.emit("error", {
            message: "The runner for this session is offline — the conversation will load when it reconnects.",
            generation,
        });
    });
}

/**
 * Replay a persisted (SQLite + Redis) snapshot for a session that is
 * no longer live. Uses the SnapshotProvider to find the best available
 * snapshot, sends it, then disconnects the viewer.
 */
async function replayPersistedSnapshot(
    socket: ViewerSocket,
    sessionId: string,
    userId: string,
    generation?: number,
): Promise<void> {
    try {
        // Validate ownership via persisted snapshot lookup first
        const persistedRow = await getPersistedRelaySessionSnapshot(sessionId, userId);
        if (!persistedRow) {
            socket.emit("error", { message: "Session not found" });
            socket.disconnect();
            return;
        }

        // Don't mark replay-only connections as hub-meta authoritative — there
        // is no live hub meta subscription, so the client must apply metadata
        // from the session_active snapshot directly.
        socket.emit("connected", { sessionId, replayOnly: true, generation });

        // Use SnapshotProvider to find the best snapshot (cache > persisted)
        const result = await getBestSnapshot(sessionId, { userId });

        if (result) {
            result.send(socket, generation);
        } else {
            // No snapshot available from any source
            socket.emit("error", { message: "Session snapshot not available" });
            socket.disconnect();
            return;
        }

        socket.emit("disconnected", {
            reason: "Session is no longer live (snapshot replay).",
            code: "snapshot_replay",
            generation,
        });
        // Use disconnect() without `true` so the client can still auto-reconnect
        // when the session comes back online. disconnect(true) sets reason to
        // "io server disconnect" on the client, which permanently disables
        // socket.io's auto-reconnect logic.
        socket.disconnect();
    } catch (error) {
        socket.emit("error", { message: "Failed to load session snapshot" });
        socket.disconnect();
        log.error("Failed to replay persisted snapshot:", error);
    }
}

// ── Namespace registration ───────────────────────────────────────────────────

export function registerViewerNamespace(io: SocketIOServer, context: AuthContext): void {
    const viewer: Namespace<
        ViewerClientToServerEvents,
        ViewerServerToClientEvents,
        ViewerInterServerEvents,
        ViewerSocketData
    > = io.of("/viewer");

    // Auth: validate session cookie from handshake
    viewer.use(browserAuthMiddleware(context) as Parameters<typeof viewer.use>[0]);

    viewer.on("connection", bindAuthContext(context, async (socket) => {
        bindSocketHandlersToAuthContext(socket, context);
        // Optional initial session ID from the handshake. Newer clients keep one
        // viewer socket alive and switch sessions logically via switch_session,
        // but we preserve handshake-based bootstrap for backward compatibility.
        const initialSessionId =
            (typeof socket.handshake.auth?.sessionId === "string"
                ? socket.handshake.auth.sessionId
                : undefined) ??
            (typeof socket.handshake.query?.sessionId === "string"
                ? socket.handshake.query.sessionId
                : undefined) ??
            "";

        const viewerUserId = socket.data.userId;
        if (!viewerUserId) {
            socket.emit("error", { message: "Unauthorized" });
            socket.disconnect(true);
            return;
        }

log.info(`connected: ${socket.id} userId=${viewerUserId}`);

        if (socket.data.protocolCompatible === false) {
            socket.emit("error", {
                message: "Protocol mismatch detected between UI and server. Some real-time features may be unavailable until you refresh/update the UI.",
            });
        }

        // ── Register ALL event handlers FIRST ────────────────────────────────
        // Handlers must be registered synchronously before any async work
        // (snapshot sending, addViewer, etc.) to avoid a race condition where
        // the client receives "connected", immediately fires "exec" or
        // "input", but the handler isn't registered yet because we're still
        // awaiting Redis calls. This is the root cause of Check+Kill failing
        // for non-active sessions (especially when ending 3+ sessions at
        // once — the concurrent async work widens the race window).

        // Gate forwarding of viewer "connected" → runner until this viewer has
        // joined the room. Otherwise a fast runner can emit session_active/chunks
        // before addViewer() completes, forcing a resync and visible startup lag.
        let viewerReadyForRunnerSignal = false;
        const serviceMessageRateLimit: ServiceMessageRateLimitState = { count: 0, resetAt: 0 };
        let pendingConnectedSignal = false;
        // Set by cache-first hydration to prevent the client's "connected" echo
        // from triggering a runner signal when the viewer was already hydrated
        // from the server-side Redis cache.
        let suppressRunnerSignal = false;
        // Monotonic activation token: generation checks alone cannot catch a
        // watchdog retry that reuses the SAME generation. Two overlapping
        // activations racing across getBestSnapshot()'s await could otherwise
        // consume or overwrite each other's socket-wide signal flags
        // (suppressRunnerSignal / pendingConnectedSignal) or double-signal the
        // runner. Every await inside activateSession re-checks the token and
        // bails if a newer activation has started.
        let activationCounter = 0;
        // One-shot persisted-tier fallback for a CONFIRMED-offline runner, set
        // by the active hydration attempt. Shared so both recovery-signal
        // paths (in-activation flush and the later client "connected" echo)
        // behave identically regardless of arrival timing.
        let recoveryOfflineFallback: { sessionId: string; run: () => Promise<void> } | null = null;

        const getCurrentSessionId = (): string | null => socket.data.sessionId ?? null;
        const getCurrentGeneration = (): number | undefined =>
            typeof socket.data.generation === "number" ? socket.data.generation : undefined;

        const activateSession = async (nextSessionId: string, generation?: number, lastSeq?: number): Promise<void> => {
            const activationToken = ++activationCounter;
            const activationCurrent = () => activationToken === activationCounter;
            // Reset on every session switch so a prior session's signal state
            // cannot bleed into the new session.  Specifically:
            //   - suppressRunnerSignal=true (cache hit) must not silence the
            //     runner signal for a subsequent cache-miss session.
            //   - viewerReadyForRunnerSignal=true (cache miss) must not cause
            //     the client "connected" echo to forward a runner signal before
            //     cache hydration has had a chance to run on the new session.
            //   - pendingConnectedSignal=true must not carry over and trigger
            //     forwardRecoveryConnectedSignal() against the wrong session.
            suppressRunnerSignal = false;
            viewerReadyForRunnerSignal = false;
            pendingConnectedSignal = false;
            recoveryOfflineFallback = null;

            if (!nextSessionId) {
                socket.data.sessionId = undefined;
                return;
            }

            socket.data.generation = generation;
            const previousSessionId = getCurrentSessionId();
            if (previousSessionId && previousSessionId !== nextSessionId) {
                await removeViewer(previousSessionId, socket);
                if (!isViewerSwitchCurrent(getCurrentGeneration(), generation) || !activationCurrent()) return;
            }

            const sessionSummary = await getSharedSessionSummary(nextSessionId);
            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation) || !activationCurrent()) return;

            if (!sessionSummary) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            if (!sessionSummary.userId || sessionSummary.userId !== viewerUserId) {
                socket.data.sessionId = undefined;
                socket.emit("error", { message: "Session not found", generation });
                return;
            }

            // Join the room first, then allow the viewer's "connected" signal to
            // reach the runner. This avoids losing the first live snapshot/chunks
            // and reduces startup resync churn.
            const ok = await addViewer(nextSessionId, socket, {
                sessionSummaryHint: sessionSummary,
                touchAsync: true,
            });
            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation) || !activationCurrent()) {
                // Only leave the room when the viewer is no longer on this
                // session. A same-session retry (re-click or watchdog, whether
                // it bumped the generation or only the token) shares this room —
                // Socket.IO rooms are not reference-counted, so removing here
                // would kick the CURRENT activation out and silently detach the
                // viewer from all live events.
                if (ok && getCurrentSessionId() !== nextSessionId) {
                    await removeViewer(nextSessionId, socket);
                }
                return;
            }
            if (!ok) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            socket.data.sessionId = nextSessionId;

            // ── Cache-first hydration ────────────────────────────────────
            // Re-fetch session state and seq AFTER addViewer() to avoid
            // emitting stale data. Between the initial fetch and here, the
            // runner may have published a newer session_active (especially
            // for chunked delivery).
            const [freshSession, freshSeq] = await Promise.all([
                getSharedSession(nextSessionId),
                getSessionSeq(nextSessionId),
            ]);

            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation) || !activationCurrent()) {
                // Same-room caveat as above: only remove when no longer on
                // this session.
                if (getCurrentSessionId() !== nextSessionId) {
                    await removeViewer(nextSessionId, socket);
                }
                return;
            }

            if (!freshSession) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            const requestedLastSeq = typeof lastSeq === "number" && Number.isFinite(lastSeq) ? lastSeq : undefined;

            // Always send the server's authoritative seq — never echo the
            // client's requestedLastSeq.  If the server seq reset (relay
            // restart) the client would keep its stale high cursor via
            // mergeConnectedSeq(Math.max) and reject all new events as stale.
            socket.emit("connected", withHubMetaSource({
                sessionId: nextSessionId,
                lastSeq: freshSeq,
                isActive: freshSession.isActive,
                lastHeartbeatAt: freshSession.lastHeartbeatAt,
                sessionName: freshSession.sessionName,
                generation,
            }));

            // Send cached service_announce so the viewer knows which runner
            // services are available without waiting for a fresh announce.
            log.info(`service_announce check: runnerId=${freshSession.runnerId ?? "null"}`);
            if (freshSession.runnerId) {
                const announce = getRunnerServiceAnnounce(freshSession.runnerId);
                const serviceIds = announce?.serviceIds ?? [];
                log.info(`service_announce: runnerId=${freshSession.runnerId}, cached serviceIds=[${serviceIds.join(",")}]`);
                if (serviceIds.length > 0) {
                    socket.emit("service_announce", { ...withRunnerRefHint(freshSession.runnerId, announce!), generation });
                }
            }

            // ── SnapshotProvider: try server-side cache before signaling the runner
            const chunkedPending = getPendingChunkedSnapshot(nextSessionId);
            const staleChunkStream = chunkedPending?.stale === true;
            if (!chunkedPending || staleChunkStream) {
                const snapshotResult = await getBestSnapshot(nextSessionId, {
                    lastSeq: requestedLastSeq,
                    // Without userId the SQLite tier is unreachable, so a dead
                    // session whose Redis cache aged out could never hydrate here.
                    // Only offer it for sessions that are actually finished: the
                    // persisted copy is a throttled snapshot, so serving it for a
                    // live session whose cache merely blipped would show a stale
                    // transcript AND suppress the runner signal that would have
                    // fixed it — with no error and no retry.
                    //
                    // "Actually live" requires a fresh heartbeat, not just the
                    // stored isActive flag: a hung runner keeps isActive=true
                    // for 2+ minutes (until sweepOrphanedSessions), which
                    // blocked the SQLite tier for exactly the sessions that
                    // need it.
                    userId: runnerLooksLive(freshSession) ? undefined : viewerUserId,
                    lastState: freshSession.lastState,
                    snapshotOverlay: freshSession.snapshotOverlay,
                    chunkedPending: false,
                    latestSeq: freshSeq,
                });
                if (!activationCurrent()) return; // newer activation owns the signal flags now
                if (snapshotResult) {
                    // Cache hit — viewer is fully hydrated.  Suppress the
                    // runner "connected" signal so it doesn't rebuild and
                    // broadcast to all viewers in the room.
                    snapshotResult.send(socket, generation);
                    suppressRunnerSignal = true;
                    log.info(`snapshot-provider hydration: sessionId=${nextSessionId} viewer=${socket.id} type=${snapshotResult.snapshot.type}`);
                    if (staleChunkStream) {
                        // The cache served a pre-stream checkpoint over a wedged
                        // chunk stream — that transcript is old. Ask the runner
                        // for a fresh snapshot instead of suppressing recovery,
                        // so the viewer isn't stranded on the old checkpoint if
                        // the stream never finishes.
                        forwardRecoverySignalOrNotify(nextSessionId, socket, generation);
                    }
                    return;
                }
            }

            // ── Cache miss — cold-start fallback ─────────────────────────
            // Signal the runner so it rebuilds and emits session_active.
            // This is the existing pre-optimization path.
            log.info(`cache miss fallback: sessionId=${nextSessionId} viewer=${socket.id}`);
            suppressRunnerSignal = false;
            viewerReadyForRunnerSignal = true;
            const flush = onViewerReadyForRunnerSignal(pendingConnectedSignal);
            pendingConnectedSignal = flush.pendingConnectedSignal;

            // Persisted-tier fallback for a CONFIRMED-offline runner: its recent
            // heartbeat is no longer evidence of liveness, so the SQLite tier
            // that runnerLooksLive() blocked above is fair game. One-shot, and
            // every await re-checks that (a) this activation still owns the
            // socket and (b) no live event advanced the session seq — a runner
            // reconnecting mid-lookup broadcasts fresher content than anything
            // persisted, and sending after it would rewind the transcript.
            // Cursor-holding viewers skip the snapshot (seqless → rewind risk);
            // their watchdog retries cursorless and lands here next attempt.
            let fallbackAttempted = false;
            const attemptPersistedFallback = async (): Promise<void> => {
                if (fallbackAttempted) return;
                fallbackAttempted = true;
                const stillMine = () => activationCurrent() && socket.data.sessionId === nextSessionId;
                if (!stillMine()) return;
                try {
                    const seqNow = await getSessionSeq(nextSessionId);
                    if (!stillMine() || seqNow !== freshSeq) return;
                    if (requestedLastSeq === undefined) {
                        const persisted = await getBestSnapshot(nextSessionId, {
                            userId: viewerUserId,
                            lastState: freshSession.lastState,
                            snapshotOverlay: freshSession.snapshotOverlay,
                            chunkedPending: false,
                            latestSeq: freshSeq,
                        });
                        const seqAfter = await getSessionSeq(nextSessionId);
                        if (!stillMine() || seqAfter !== freshSeq) return;
                        if (persisted) {
                            persisted.send(socket, generation);
                            log.info(`persisted fallback after confirmed-offline runner: sessionId=${nextSessionId} viewer=${socket.id} type=${persisted.snapshot.type}`);
                            return;
                        }
                    }
                } catch (err) {
                    log.warn(`persisted fallback failed for ${nextSessionId}:`, (err as Error)?.message);
                }
                if (!stillMine()) return;
                socket.emit("error", {
                    message: "The runner for this session is offline — the conversation will load when it reconnects.",
                    generation,
                });
            };
            recoveryOfflineFallback = { sessionId: nextSessionId, run: attemptPersistedFallback };

            if (flush.forwardNow) {
                forwardRecoverySignalOrNotify(nextSessionId, socket, generation, attemptPersistedFallback);
            }

            // Emit an immediate heartbeat snapshot while the runner pushes a
            // fresh session_active in response to "connected".
            if (freshSession.lastHeartbeat) {
                try {
                    socket.emit("event", {
                        event: withLivenessOnlyHint(JSON.parse(freshSession.lastHeartbeat)),
                        seq: freshSeq,
                        generation,
                        sessionId: nextSessionId,
                    });
                } catch {}
            }

            // Nothing further to try here. getBestSnapshot() has already
            // exhausted every source it is allowed to use for this viewer
            // (cache delta, cache snapshot, lastState, SQLite), so the runner
            // recovery signal above is the only remaining path to content.
            //
            // The old code re-attempted lastState and a second cache read at
            // this point. Both were unreachable-or-unsafe: getBestSnapshot had
            // just tried the identical Redis key, and re-sending unsequenced
            // lastState to a viewer holding a cursor is exactly the rewind the
            // seq comparison exists to prevent.
        };

        // ── switch_session — reuse the viewer socket across session changes ─
        socket.on("switch_session", async (data) => {
            if (!data || typeof data.sessionId !== "string" || !data.sessionId) return;
            await activateSession(
                data.sessionId,
                typeof data.generation === "number" ? data.generation : undefined,
                typeof data.lastSeq === "number" ? data.lastSeq : undefined,
            );
        });

        // ── connected — viewer greeting, notify TUI ─────────────────────────
        // Use emitToRelaySession for cluster-wide reach — the runner may
        // be on a different server node in multi-node deployments.
        socket.on("connected", () => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            // When the viewer was hydrated from the server-side cache,
            // suppress the runner signal — the runner doesn't need to
            // rebuild and rebroadcast the transcript.
            if (suppressRunnerSignal) return;
            const next = onViewerConnectedSignal(viewerReadyForRunnerSignal, pendingConnectedSignal);
            pendingConnectedSignal = next.pendingConnectedSignal;
            if (next.forwardNow) {
                // Route through the activation's persisted fallback when one is
                // armed — identical cold starts must not behave differently
                // based on whether this echo raced the cache lookup.
                const fallback = recoveryOfflineFallback?.sessionId === currentSessionId
                    ? recoveryOfflineFallback.run
                    : undefined;
                forwardRecoverySignalOrNotify(currentSessionId, socket, getCurrentGeneration(), fallback);
            }
        });

        // ── viewer_visibility — tab visible/hidden, drives native push suppression ──
        // ponytail: state lives on socket.data (already replicated to other nodes
        // by the Redis adapter for fetchSockets()), so no new Redis key is needed.
        socket.on("viewer_visibility", (data) => {
            socket.data.viewerVisible = data?.visible !== false;
        });

        // ── resync — send fresh snapshot ─────────────────────────────────────
        socket.on("resync", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            // Never answer an in-flight chunk resync with lastState: it is the
            // previous completed checkpoint until server assembly finishes.
            // The client keeps the last good transcript visible and retries on
            // an incomplete final chunk, after finalization is durable.
            //
            // getPendingChunkedSnapshot() is node-local. Multi-node deployments
            // still need sticky routing or shared pending state for this guard.
            const requestedLastSeq = typeof data?.lastSeq === "number" && Number.isFinite(data.lastSeq) ? data.lastSeq : undefined;
            // A stale stream (no chunk for CHUNK_STREAM_STALE_MS) must not gate
            // hydration — treat it as absent for the fallback decisions below,
            // but remember it so we still nudge the runner for a fresh snapshot.
            const resyncPendingRaw = getPendingChunkedSnapshot(currentSessionId);
            const resyncStaleStream = resyncPendingRaw?.stale === true;
            const resyncChunkedPending = resyncPendingRaw && !resyncStaleStream ? resyncPendingRaw : null;
            if (requestedLastSeq !== undefined && !resyncChunkedPending) {
                const [resyncSession, resyncSeq] = await Promise.all([
                    getSharedSession(currentSessionId),
                    getSessionSeq(currentSessionId),
                ]);
                const cacheHydrated = await hydrateViewerFromCache(socket, currentSessionId, {
                    lastSeq: requestedLastSeq,
                    generation: getCurrentGeneration(),
                    snapshotOverlay: resyncSession?.snapshotOverlay,
                    latestSessionSeq: resyncSeq,
                });
                if (cacheHydrated) {
                    if (resyncStaleStream) {
                        forwardRecoverySignalOrNotify(currentSessionId, socket, getCurrentGeneration());
                    }
                    return;
                }
            }
            if (shouldAvoidSnapshotFallback(requestedLastSeq, resyncChunkedPending)) {
                // The cache is seq-aware now and will already have replayed a
                // snapshot if one provably sat at or ahead of the client cursor.
                // Reaching here means only unsequenced state is left, which
                // cannot safely fill the gap — ask the runner for a fresh one.
                if (requestedLastSeq !== undefined && !resyncChunkedPending) {
                    forwardRecoverySignalOrNotify(currentSessionId, socket, getCurrentGeneration());
                }
                return;
            }

            await sendSnapshotToViewer(currentSessionId, socket);

            // If no lastState was available (e.g. mid-chunked-delivery),
            // ask the runner to re-emit a fresh snapshot rather than sending
            // a partial non-chunked SA (which would set lastCompletedSnapshotRef
            // and cause the UI to reject all subsequent chunks from the
            // still-active stream).
            // Use emitToRelaySession for cluster-wide reach — the runner may
            // be on a different server node in multi-node deployments.
            const session = await getSharedSession(currentSessionId);
            if (!session?.lastState || resyncStaleStream) {
                // No usable checkpoint — or the one we just sent predates a
                // wedged chunk stream — either way the runner should rebuild.
                emitToRelaySession(currentSessionId, "connected" as string, {});
            }
        });

        // ── input — collab mode: forward user input to TUI ──────────────────
        socket.on("input", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            // Parse and validate attachments
            const attachments = Array.isArray(data.attachments)
                ? data.attachments
                      .filter(
                          (entry): entry is Record<string, unknown> =>
                              entry !== null && typeof entry === "object",
                      )
                      .map((item) => ({
                          attachmentId:
                              typeof item.attachmentId === "string" ? item.attachmentId : undefined,
                          mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
                          filename: typeof item.filename === "string" ? item.filename : undefined,
                          url: typeof item.url === "string" ? item.url : undefined,
                      }))
                      .filter(
                          (item) =>
                              (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
                              (typeof item.url === "string" && item.url.length > 0),
                      )
                : [];

            const payload: Record<string, unknown> = {
                text: data.text,
                attachments,
            };
            if (data.client) payload.client = data.client;
            if (data.deliverAs === "steer" || data.deliverAs === "followUp") {
                payload.deliverAs = data.deliverAs;
            }

            tuiSocket.emit("input" as string, payload);
        });

        // ── model_set — collab mode: forward model switch to TUI ─────────────
        socket.on("model_set", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) return;

            // Hard-block hidden models by name (same rule as the spawn route).
            // Fresh DB read — the worker's env copy may be stale.
            try {
                const hiddenModels = await getHiddenModels(viewerUserId);
                if (isHiddenModel(hiddenModels, { provider: String(data?.provider ?? ""), id: String(data?.modelId ?? "") })) {
                    log.warn(`blocked model_set of hidden model ${data.provider}/${data.modelId} on ${currentSessionId}`);
                    return;
                }
            } catch {
                // On lookup failure, fall through — the worker-side guard still applies.
            }

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("model_set" as string, {
                provider: data.provider,
                modelId: data.modelId,
            });
        });

        // ── exec — collab mode: forward remote command to TUI ────────────────
        socket.on("exec", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("exec" as string, data);
        });

        // ── mcp_oauth_paste — user pasted OAuth callback URL ──────────────
        // Forward the extracted auth code to the runner's relay session so
        // the OAuth provider can complete the token exchange.
        // Uses verified delivery (like trigger_response): acks on success
        // so the UI can distinguish delivered pastes from dropped ones.
        socket.on("mcp_oauth_paste", async (data: any, ack?: (...args: any[]) => void) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) {
                if (typeof ack === "function") ack({ ok: false, error: "No active session" });
                return;
            }
            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) {
                if (typeof ack === "function") ack({ ok: false, error: "Session not in collab mode" });
                return;
            }

            const { nonce, code, state } = data ?? {};
            if (typeof nonce !== "string" || typeof code !== "string") {
                if (typeof ack === "function") ack({ ok: false, error: "Missing nonce or code" });
                return;
            }

            const payload = {
                nonce,
                code,
                ...(typeof state === "string" ? { state } : {}),
            };

            // Try local TUI socket first, fall back to relay room.
            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (tuiSocket) {
                tuiSocket.emit("mcp_oauth_paste" as string, payload);
                if (typeof ack === "function") ack({ ok: true });
            } else if (await emitToRelaySessionVerified(currentSessionId, "mcp_oauth_paste", payload)) {
                if (typeof ack === "function") ack({ ok: true });
            } else {
                if (typeof ack === "function") ack({ ok: false, error: "Runner session unavailable" });
            }
        });

        // ── trigger_response — human viewer responds to child trigger ────────
        // Route directly to the child session via its relay socket,
        // bypassing the parent CLI. This avoids depending on an in-memory
        // handler in the parent to forward the response.
        socket.on("trigger_response", async (data: any, ack?: (...args: any[]) => void) => {
            const { triggerId, response, action, targetSessionId } = data ?? {};
            if (!triggerId || response == null) return;

            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;

            // Require collab mode — same gate as input/exec/model_set
            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) return;

            // If targetSessionId is explicitly provided, route to that child.
            // Validate ownership: the target session must belong to the same user.
            if (targetSessionId) {
                const targetSession = await getSharedSessionSummary(targetSessionId);
                if (!targetSession) {
                    // Target session no longer exists (child exited) — don't ack so the
                    // UI keeps retry controls visible, and emit trigger_error for feedback.
                    socket.emit("trigger_error", { message: `Child session ${targetSessionId} is no longer available`, triggerId });
                    return;
                }
                if (targetSession.userId !== viewerUserId) {
                    // Security: belongs to a different user — nack with trigger_error.
                    socket.emit("trigger_error", { message: `Target session ${targetSessionId} not found or unauthorized`, triggerId });
                    return;
                }
                // Security: verify the target is a child of the current session to prevent
                // cross-session trigger injection between unrelated sessions of the same user.
                const childVerified = await isChildOfParent(currentSessionId, targetSessionId);
                if (!childVerified) {
                    socket.emit("trigger_error", { message: `Target session ${targetSessionId} is not a child of this session`, triggerId });
                    return;
                }
                const triggerPayload = {
                    triggerId,
                    response,
                    ...(action ? { action } : {}),
                };
                // Try local socket first, fall back to relay room for cross-node delivery.
                // Only ack on successful delivery so the client can distinguish
                // delivered responses from dropped ones.
                const childSocket = getLocalTuiSocket(targetSessionId);
                if (childSocket) {
                    childSocket.emit("trigger_response" as string, triggerPayload);
                    // Record the response in the parent's trigger history so the
                    // TriggersPanel shows it as responded (not perpetually pending).
                    void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                    broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                    if (typeof ack === "function") ack();
                } else if (await emitToRelaySessionVerified(targetSessionId, "trigger_response", triggerPayload)) {
                    void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                    broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                    if (typeof ack === "function") ack();
                } else {
                    socket.emit("trigger_error", { message: `Failed to deliver trigger response to child session ${targetSessionId}`, triggerId });
                }
                return;
            }

            // Fallback: forward to the parent session's TUI socket (or relay room)
            const triggerPayloadForParent = {
                triggerId,
                response,
                ...(action ? { action } : {}),
                targetSessionId,
            };
            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (tuiSocket) {
                tuiSocket.emit("trigger_response" as string, triggerPayloadForParent);
                void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                if (typeof ack === "function") ack();
            } else if (await emitToRelaySessionVerified(currentSessionId, "trigger_response", triggerPayloadForParent)) {
                void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                if (typeof ack === "function") ack();
            } else {
                socket.emit("trigger_error", { message: `Failed to deliver trigger response to session ${currentSessionId}`, triggerId });
            }
        });

        // ── service_message — viewer → runner: forward service envelope ──────
        // Viewers send service_message to interact with runner services
        // (e.g. request file listings, git status, etc.) without the relay
        // needing to understand service-specific semantics.
        // IMPORTANT: service handlers are registered on the /runner namespace
        // socket, NOT on the /relay TUI socket. emitToRelaySession would target
        // the TUI worker (/relay namespace) which does NOT handle service_message
        // events — all viewer-initiated service requests would be silently dropped.
        // We must route to the runner via emitToRunner(runnerId, ...) instead.
        socket.on("service_message", async (envelope: ServiceEnvelope) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;

            const forwardEnvelope = { ...envelope, sessionId: currentSessionId };

            const sizeCheck = checkServiceMessageSize(forwardEnvelope);
            if (!sizeCheck.ok) {
                log.warn(
                    `[service_message] dropped from viewer socket ${socket.id}: ${sizeCheck.reason} (bytes=${sizeCheck.bytes})`,
                );
                return;
            }

            const rateCheck = checkServiceMessageRateLimit(Date.now(), serviceMessageRateLimit);
            if (!rateCheck.allowed) {
                log.warn(
                    `[service_message] dropped from viewer socket ${socket.id}: rate limit exceeded (${MAX_SERVICE_MESSAGE_PER_SECOND}/${SERVICE_MESSAGE_RATE_WINDOW_MS}ms)`,
                );
                return;
            }

            const currentSession = await getSharedSessionSummary(currentSessionId);
            if (!currentSession?.collabMode) return;
            const runnerId = currentSession.runnerId;
            if (!runnerId) return;

            // Attach sessionId so the runner service knows which session to respond to
            emitToRunner(runnerId, "service_message", forwardEnvelope);
        });

        // ── load_messages — fetch older transcript pages on demand ──────────
        socket.on("load_messages", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            if (!data || data.sessionId !== currentSessionId) return;
            if (typeof data.before !== "number" || !Number.isFinite(data.before)) return;
            if (typeof data.limit !== "number" || !Number.isFinite(data.limit)) return;

            let fullState: Record<string, unknown> | null = null;
            const currentSession = await getSharedSession(currentSessionId);
            if (currentSession?.lastState) {
                try {
                    const parsed = JSON.parse(currentSession.lastState);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        fullState = parsed as Record<string, unknown>;
                    }
                } catch {}
            }

            if (!fullState) {
                const snapshotEvent = (await getLatestCachedSnapshotEvent(currentSessionId))?.event ?? null;
                if (snapshotEvent?.type === "session_active") {
                    const snapshotState = snapshotEvent.state;
                    if (snapshotState && typeof snapshotState === "object" && !Array.isArray(snapshotState)) {
                        fullState = snapshotState as Record<string, unknown>;
                    }
                } else if (snapshotEvent && Array.isArray(snapshotEvent.messages)) {
                    fullState = snapshotEvent;
                }
            }

            const messages = Array.isArray(fullState?.messages) ? fullState.messages : [];
            const before = Math.max(0, Math.min(Math.trunc(data.before), messages.length));
            const limit = Math.max(0, Math.trunc(data.limit));
            const startIndex = Math.max(0, before - limit);
            const endIndex = before;

            socket.emit("session_messages_page", {
                sessionId: currentSessionId,
                messages: messages.slice(startIndex, endIndex),
                hasMore: startIndex > 0,
                oldestIndex: startIndex,
                generation: getCurrentGeneration(),
            });
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            const currentSessionId = getCurrentSessionId();
            log.info(`disconnected: ${socket.id} sessionId=${currentSessionId ?? "none"} (${reason})`);
            if (currentSessionId) {
                await removeViewer(currentSessionId, socket);
            }
        });

        // ── Optional initial session bootstrap (backward compatibility) ─────
        if (initialSessionId) {
            const initialSession = await getSharedSessionSummary(initialSessionId);
            if (!initialSession) {
                // Session not live — try to replay a persisted snapshot for older
                // clients that still bind the session in the handshake.
                await replayPersistedSnapshot(socket, initialSessionId, viewerUserId);
                return;
            }

            if (!initialSession.userId || initialSession.userId !== viewerUserId) {
                socket.emit("error", { message: "Session not found" });
                socket.disconnect(true);
                return;
            }

            await activateSession(initialSessionId, 0);
        }
    }));
}
