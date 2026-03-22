// runners-broadcast.ts — Helpers for broadcasting runner events to /runners namespace
// Room helper lives in context.ts (alongside hubUserRoom) to avoid circular deps.
import { getIo, runnersUserRoom } from "./context.js";

/**
 * Broadcast a runner lifecycle event to all connected /runners clients.
 * Scoped to a specific user via their room when userId is provided.
 * Mirrors the hub.ts broadcast pattern.
 */
export async function broadcastToRunnersNs(
    eventName: string,
    data: unknown,
    userId?: string,
): Promise<void> {
    const io = getIo();
    try {
        const runnersNs = io.of("/runners");
        if (userId) {
            runnersNs.to(runnersUserRoom(userId)).emit(eventName, data);
        } else {
            runnersNs.emit(eventName, data);
        }
    } catch (err) {
        console.warn("[sio-registry] broadcastToRunnersNs failed, falling back to local:", (err as Error)?.message);
        try {
            const runnersNs = io.of("/runners");
            if (userId) {
                runnersNs.local.to(runnersUserRoom(userId)).emit(eventName, data);
            } else {
                runnersNs.local.emit(eventName, data);
            }
        } catch {
            // Nothing more we can do
        }
    }
}
