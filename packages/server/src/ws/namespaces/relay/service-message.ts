// ── Service message relay — TUI session → runner daemon ──────────────────────
//
// Allows agent sessions (connected via the /relay namespace) to send
// service_message envelopes to the runner daemon's ServiceHandler system.
// This mirrors the viewer → runner path but originates from the TUI worker
// instead of a browser viewer.

import type { ServiceEnvelope } from "@pizzapi/protocol";
import { getSharedSession } from "../../sio-registry/sessions.js";
import { emitToRunner } from "../../sio-registry/context.js";
import type { RelaySocket } from "./types.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/relay");

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

export function registerServiceMessageHandler(socket: RelaySocket): void {
    const rateLimit: ServiceMessageRateLimitState = { count: 0, resetAt: 0 };

    socket.on("service_message" as any, async (envelope: ServiceEnvelope) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId) return;

        const forwardEnvelope = { ...envelope, sessionId };

        const sizeCheck = checkServiceMessageSize(forwardEnvelope);
        if (!sizeCheck.ok) {
            log.warn(
                `[service_message] dropped from relay socket ${socket.id}: ${sizeCheck.reason} (bytes=${sizeCheck.bytes})`,
            );
            return;
        }

        const rateCheck = checkServiceMessageRateLimit(Date.now(), rateLimit);
        if (!rateCheck.allowed) {
            log.warn(
                `[service_message] dropped from relay socket ${socket.id}: rate limit exceeded (${MAX_SERVICE_MESSAGE_PER_SECOND}/${SERVICE_MESSAGE_RATE_WINDOW_MS}ms)`,
            );
            return;
        }

        const session = await getSharedSession(sessionId);
        if (!session?.collabMode) return;

        const runnerId = session.runnerId;
        if (!runnerId) return;

        // Attach sessionId so the runner service knows which session to
        // respond to (same pattern as the viewer namespace).
        emitToRunner(runnerId, "service_message", forwardEnvelope);
    });
}
