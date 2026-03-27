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

export function registerServiceMessageHandler(socket: RelaySocket): void {
    socket.on("service_message" as any, async (envelope: ServiceEnvelope) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId) return;

        const session = await getSharedSession(sessionId);
        if (!session?.collabMode) return;

        const runnerId = session.runnerId;
        if (!runnerId) return;

        // Attach sessionId so the runner service knows which session to
        // respond to (same pattern as the viewer namespace).
        emitToRunner(runnerId, "service_message", { ...envelope, sessionId });
    });
}
