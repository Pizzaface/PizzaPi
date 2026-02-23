/**
 * legacy-shim.ts — Backward-compatibility layer for raw WebSocket clients.
 *
 * Old CLI versions (pre-Socket.IO migration) connect via Bun.serve() raw
 * WebSocket endpoints (/ws/sessions, /ws/runner, etc.) and interact with the
 * in-memory registry (registry.ts + relay.ts).
 *
 * New clients use Socket.IO (on a separate port) backed by Redis
 * (sio-registry.ts + sio-state.ts).
 *
 * During the transition period both paths coexist:
 *
 *   ┌─────────────┐          ┌──────────────────┐
 *   │  Old CLI     │─── ws ──▶│ Bun.serve raw WS │──▶ registry.ts (in-memory)
 *   └─────────────┘          └──────────────────┘
 *
 *   ┌─────────────┐          ┌──────────────────┐
 *   │  New Client  │─ sio ──▶│ node:http + SIO   │──▶ sio-registry (Redis)
 *   └─────────────┘          └──────────────────┘
 *
 * ⚠️  KNOWN LIMITATION: During the transition, old clients write to in-memory
 * state and new clients write to Redis state. Sessions created by old clients
 * will NOT be visible to Socket.IO viewers, and vice versa. This is acceptable
 * for 1-2 releases while old CLIs upgrade.
 *
 * DEPRECATION PLAN:
 *   Phase 1 (current) — PIZZAPI_LEGACY_WS defaults to "true"; old clients work
 *                        with a deprecation warning logged on each connection.
 *   Phase 2           — Default flips to "false"; old clients get 410 Gone.
 *                        Users must opt-in via PIZZAPI_LEGACY_WS=true.
 *   Phase 3           — Legacy WS support removed entirely. relay.ts, registry.ts,
 *                        routes/ws.ts, and this file are deleted.
 */

import type { WsData } from "./registry.js";

/**
 * Check whether legacy raw WebSocket endpoints should accept connections.
 *
 * Controlled by the `PIZZAPI_LEGACY_WS` environment variable:
 *   - undefined / "true" / "1"  → enabled  (Phase 1 default)
 *   - "false" / "0"             → disabled (returns 410 Gone)
 */
export function isLegacyWsEnabled(): boolean {
    const flag = process.env.PIZZAPI_LEGACY_WS;
    if (flag === undefined || flag === "") return true; // default: enabled
    return flag === "true" || flag === "1";
}

/**
 * Log a deprecation warning when a legacy raw WebSocket client connects.
 * Called once per connection in the `websocket.open` handler.
 */
export function logLegacyConnection(role: string, wsData: WsData): void {
    const userId = wsData.userId ?? "unknown";
    const sessionId = wsData.sessionId ?? "n/a";
    console.warn(
        `[legacy-ws] ⚠️  Legacy raw WebSocket ${role} connection: ` +
            `userId=${userId}, sessionId=${sessionId}. ` +
            `Please upgrade to Socket.IO client. ` +
            `Set PIZZAPI_LEGACY_WS=false to reject legacy connections.`,
    );
}

/**
 * Build the 410 Gone response returned when legacy WS support is disabled.
 */
export function legacyDisabledResponse(): Response {
    return new Response(
        "Legacy WebSocket endpoint is deprecated. Please upgrade to Socket.IO client.",
        { status: 410 },
    );
}
