/**
 * PizzaPi Remote extension — orchestrator.
 *
 * Automatically connects to the PizzaPi relay on session start and streams all
 * agent events in real-time so any browser client can pick up the session.
 *
 * Config:
 *   PIZZAPI_RELAY_URL  WebSocket URL of the relay (default: ws://localhost:7492)
 *                      Set to "off" to disable auto-connect.
 *
 * Commands:
 *   /remote            Show the current share URL (or "not connected")
 *   /remote stop       Disconnect from relay
 *   /remote reconnect  Force reconnect
 *
 * Note: The `new_session` and `resume_session` exec handlers rely on a Bun
 * patch applied to `@mariozechner/pi-coding-agent` that exposes
 * `newSession()`/`switchSession()` on the extension runtime.
 * See `patches/README.md` for details.
 *
 * Sub-modules (all in the same `remote/` folder):
 *   model-selection.ts          — setModelFromWeb handler, model registry lookup
 *   session-name-sync.ts        — startSessionNameSync, stopSessionNameSync, polling state
 *   trigger-cancellation.ts     — cancellation retry loop and batch state
 *   delink-management.ts        — emitDelinkChildren, emitDelinkOwnParent, retry timers
 *   followup-grace.ts           — startFollowUpGrace, fireSessionComplete
 *   relay-context-factory.ts    — RelayContext object, forwardEvent, sendToWeb, etc.
 *   lifecycle-handlers.ts       — all pi event listeners
 *   connection-handlers-factory.ts — ConnectionHandlers, doConnect/doDisconnect
 *   chunked-delivery.ts         — session_active chunking (untouched sub-module)
 *   registration-gate.ts        — gate for waiting until relay is registered (untouched)
 *   connection.ts               — Socket.IO connect/disconnect + server events (untouched)
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import type { RelayContext } from "../remote-types.js";
import { createTriggerWaitManager } from "../trigger-wait-manager.js";
import { waitForRelayRegistrationGated } from "./registration-gate.js";
import { estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries } from "./chunked-delivery.js";
import { createRelayContext } from "./relay-context-factory.js";
import { createSessionNameSync } from "./session-name-sync.js";
import { setModelFromWeb as _setModelFromWeb } from "./model-selection.js";
import { createCancellationManager } from "./trigger-cancellation.js";
import { createDelinkManager } from "./delink-management.js";
import { createFollowUpGrace } from "./followup-grace.js";
import { createConnectionHandlers } from "./connection-handlers-factory.js";
import { registerLifecycleHandlers } from "./lifecycle-handlers.js";

// Re-export chunked-delivery utilities so existing importers (e.g. tests) that
// import from the top-level `remote.js` barrel continue to work unchanged.
export { estimateMessagesSize, needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries };

// ── Module-level state for external consumers ─────────────────────────────────

let _ctx: RelayContext | null = null;

/** Forward a CLI-side error to all active relay viewers. */
export function forwardCliError(message: string, source?: string): void {
    _ctx?.forwardEvent({ type: "cli_error", message, source: source ?? null, ts: Date.now() });
}

/** Get the active relay socket and token, or null if not connected/registered. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRelaySocket(): { socket: Socket<RelayServerToClientEvents, RelayClientToServerEvents>; token: string } | null {
    return _ctx?.sioSocket?.connected && _ctx.relay
        ? { socket: _ctx.sioSocket, token: _ctx.relay.token }
        : null;
}

/**
 * Get the relay session ID. Returns the session ID even while disconnected
 * (e.g. during reconnect windows) so child-session linking via spawn_session
 * doesn't break. Falls back to PIZZAPI_SESSION_ID env var.
 */
export function getRelaySessionId(): string | null {
    return _ctx?.relaySessionId ?? process.env.PIZZAPI_SESSION_ID ?? null;
}

/**
 * Wait for the relay to complete registration, with a timeout fallback.
 * Resolves immediately if the relay is already registered or was skipped.
 * Falls back after `timeoutMs` so the caller isn't blocked forever if the
 * relay connection fails.
 */
export function waitForRelayRegistration(timeoutMs: number = 10_000): Promise<void> {
    if (_ctx?.relay) return Promise.resolve();
    return waitForRelayRegistrationGated(timeoutMs);
}

// ── Extension factory ─────────────────────────────────────────────────────────

export const remoteExtension: ExtensionFactory = (pi) => {
    // ── Shared mutable state (passed to all sub-module factories) ─────────────
    const st = {
        // Delink state
        pendingDelink: false,
        pendingDelinkRetryTimer: null as ReturnType<typeof setTimeout> | null,
        pendingDelinkRetryEpoch: null as number | null,
        pendingDelinkEpoch: null as number | null,
        staleChildIds: new Set<string>(),
        pendingDelinkOwnParent: false,
        pendingDelinkOwnParentRetryTimer: null as ReturnType<typeof setTimeout> | null,
        stalePrimaryParentId: null as string | null,
        serverClockOffset: 0,
        // Cancellation state
        pendingCancellations: [] as Array<{ triggerId: string; childSessionId: string }>,
        pendingCancellationRetryTimer: null as ReturnType<typeof setInterval> | null,
        pendingCancellationRetryInFlight: false,
        // Follow-up grace state
        sessionCompleteFired: false,
        followUpGraceTimer: null as ReturnType<typeof setTimeout> | null,
        followUpGraceShutdown: null as (() => void) | null,
        sessionCompleteGeneration: 0,
        sessionCompleteTransportGeneration: 0,
        sessionCompleteRetryTimer: null as ReturnType<typeof setTimeout> | null,
        pendingSessionCompleteDelivery: null as Promise<{ ok: boolean; error?: string }> | null,
        pendingSessionCompleteSocket: null,
        pendingSessionCompleteTransportGeneration: null as number | null,
        lastSessionCompletePayload: null as {
            triggerId: string;
            summary: string;
            fullOutputPath?: string;
            exitReason: "completed" | "killed" | "error";
        } | null,
        // Session name sync state
        sessionNameSyncTimer: null as ReturnType<typeof setInterval> | null,
        lastBroadcastSessionName: null as string | null,
    };

    // ── Create sub-modules ────────────────────────────────────────────────────

    const triggerWaits = createTriggerWaitManager();
    const rctx = createRelayContext(pi as any, triggerWaits, st);

    // Set module-level ref for external consumers
    _ctx = rctx;

    const sessionNameSync = createSessionNameSync(rctx, st);
    const cancellationManager = createCancellationManager(rctx, st);
    const delinkManager = createDelinkManager(rctx, st);
    const followUpGrace = createFollowUpGrace(rctx, st);

    const { doConnect, doDisconnect } = createConnectionHandlers({
        pi,
        rctx,
        state: st,
        triggerWaits,
        delinkManager,
        cancellationManager,
        followUpGrace,
        setModelFromWeb: (provider, modelId) => _setModelFromWeb(rctx, pi as any, provider, modelId),
    });

    // ── Register lifecycle event handlers ─────────────────────────────────────

    registerLifecycleHandlers({
        pi: pi as any,
        rctx,
        state: st,
        triggerWaits,
        delinkManager,
        cancellationManager,
        followUpGrace,
        startSessionNameSync: sessionNameSync.startSessionNameSync,
        stopSessionNameSync: sessionNameSync.stopSessionNameSync,
        doConnect,
        doDisconnect,
        clearCtx: () => { _ctx = null; },
    });
};
