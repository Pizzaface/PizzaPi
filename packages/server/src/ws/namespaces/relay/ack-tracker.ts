// ── Per-socket ack tracking ──────────────────────────────────────────────────
// Tracks the highest cumulative event seq acknowledged back to each TUI socket.
// Stored outside socket.data because RelaySocketData doesn't include it.

import type { RelaySocket } from "./types.js";

export const socketAckedSeqs = new Map<string, number>();

export function sendCumulativeEventAck(socket: RelaySocket, seq: number): void {
    const socketId = socket.id;
    const previous = socketAckedSeqs.get(socketId) ?? 0;
    const next = seq > previous ? seq : previous;
    socketAckedSeqs.set(socketId, next);

    const sessionId = socket.data.sessionId;
    if (sessionId) {
        try {
            socket.emit("event_ack", { sessionId, seq: next });
        } catch (err) {
            // Redis adapter can throw EPIPE when the Redis connection is temporarily
            // closed. Log and swallow — the ack is best-effort and the TUI will
            // resend any un-acked events on reconnect.
            console.warn("[sio/relay] sendCumulativeEventAck emit failed (Redis EPIPE?):", (err as Error)?.message);
        }
    }
}
