// ============================================================================
// hub.ts — Hub broadcasting and client management
//
// Manages the /hub Socket.IO namespace: joining/leaving hub rooms and
// broadcasting session lifecycle events to connected hub clients.
// ============================================================================

import type { Socket } from "socket.io";
import { getIo, HUB_ROOM, hubUserRoom } from "./context.js";

// ── Hub broadcasting ────────────────────────────────────────────────────────

/**
 * Broadcast a message to all hub clients, optionally filtered by user.
 * Uses Socket.IO rooms on the /hub namespace.
 */
export async function broadcastToHub(
    eventName: string,
    data: unknown,
    targetUserId?: string,
): Promise<void> {
    const io = getIo();
    try {
        const hubNs = io.of("/hub");
        if (targetUserId) {
            hubNs.to(hubUserRoom(targetUserId)).emit(eventName, data);
        } else {
            hubNs.to(HUB_ROOM).emit(eventName, data);
        }
    } catch (err) {
        // Redis adapter publishes before local fan-out, so EPIPE drops the
        // event for local sockets too. Fall back to local-only delivery so
        // browsers on this server still get session_added/session_removed.
        console.warn("[sio-registry] broadcastToHub failed, falling back to local:", (err as Error)?.message);
        try {
            const hubNs = io.of("/hub");
            if (targetUserId) {
                hubNs.local.to(hubUserRoom(targetUserId)).emit(eventName, data);
            } else {
                hubNs.local.to(HUB_ROOM).emit(eventName, data);
            }
        } catch {
            // Local delivery also failed — nothing more we can do.
        }
    }
}

// ── Hub client management ───────────────────────────────────────────────────

/**
 * Add a hub client socket (joins the hub room).
 * Called from the /hub namespace connection handler.
 */
export async function addHubClient(socket: Socket, userId?: string): Promise<void> {
    await socket.join(HUB_ROOM);
    if (userId) {
        await socket.join(hubUserRoom(userId));
    }
}

/**
 * Remove a hub client socket (leaves the hub room).
 * Socket.IO automatically removes sockets from rooms on disconnect,
 * but this can be called explicitly if needed.
 */
export async function removeHubClient(socket: Socket, userId?: string): Promise<void> {
    socket.leave(HUB_ROOM);
    if (userId) {
        socket.leave(hubUserRoom(userId));
    }
}
