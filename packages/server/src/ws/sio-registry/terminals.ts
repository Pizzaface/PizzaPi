// ============================================================================
// terminals.ts — Terminal management
//
// Covers:
//   - Terminal registration in Redis
//   - Viewer socket attachment and buffered replay
//   - Terminal data fan-out to viewer sockets
//   - GC timers for exited/unspawned terminals
// ============================================================================

import type { Socket } from "socket.io";
import {
    type RedisTerminalData,
    setTerminal,
    getTerminal as getTerminalState,
    updateTerminalFields,
    deleteTerminal as deleteTerminalState,
    getTerminalsForRunner as getTerminalsForRunnerState,
} from "../sio-state.js";
import {
    localTerminalViewerSockets,
    localTerminalBuffers,
    localTerminalGcTimers,
    terminalRoom,
} from "./context.js";
import { createLogger } from "@pizzapi/tools";

// ── Terminal Management ─────────────────────────────────────────────────────

const log = createLogger("sio-terminal");

export interface TerminalSpawnOpts {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
}

/** How long to keep a terminal entry after exit waiting for a late viewer (ms). */
const TERMINAL_GC_DELAY_MS = 30_000;

/** How long to wait for a viewer before cleaning up an unspawned terminal (ms). */
const TERMINAL_PENDING_TIMEOUT_MS = 60_000;

/**
 * Register a terminal in Redis + set up local buffer and GC timer.
 */
export async function registerTerminal(
    terminalId: string,
    runnerId: string,
    userId: string,
    spawnOpts: TerminalSpawnOpts = {},
): Promise<void> {
    const data: RedisTerminalData = {
        terminalId,
        runnerId,
        userId,
        spawned: false,
        exited: false,
        spawnOpts: JSON.stringify(spawnOpts),
    };

    await setTerminal(terminalId, data);
    localTerminalBuffers.set(terminalId, []);

    // GC timer: if no viewer connects within timeout, remove unspawned terminal
    const timer = setTimeout(async () => {
        const t = await getTerminalState(terminalId);
        if (t && !t.spawned) {
            log.info(`GC: removing unspawned terminal ${terminalId} (no viewer within ${TERMINAL_PENDING_TIMEOUT_MS}ms)`);
            await cleanupTerminal(terminalId);
        }
    }, TERMINAL_PENDING_TIMEOUT_MS);

    localTerminalGcTimers.set(terminalId, timer);
}

/**
 * Attach a viewer socket to a terminal.
 * Replays buffered messages and joins the terminal room.
 */
export async function setTerminalViewer(terminalId: string, socket: Socket): Promise<boolean> {
    const entry = await getTerminalState(terminalId);
    if (!entry) return false;

    const viewers = localTerminalViewerSockets.get(terminalId) ?? new Set<Socket>();
    viewers.add(socket);
    localTerminalViewerSockets.set(terminalId, viewers);
    await socket.join(terminalRoom(terminalId));

    // Clear pending-timeout timer
    const pendingTimer = localTerminalGcTimers.get(terminalId);
    if (pendingTimer && !entry.spawned) {
        clearTimeout(pendingTimer);
        localTerminalGcTimers.delete(terminalId);
    }

    // Replay buffered messages
    const buffer = localTerminalBuffers.get(terminalId) ?? [];
    if (buffer.length > 0) {
        log.info(`replaying ${buffer.length} buffered messages for terminal ${terminalId}`);
        for (const msg of buffer) {
            const msgObj = msg as Record<string, unknown>;
            const eventName = (msgObj.type as string) ?? "terminal_data";
            socket.emit(eventName, msg);
        }
        buffer.length = 0;
    }

    // If terminal already exited, schedule cleanup
    if (entry.exited) {
        const existingTimer = localTerminalGcTimers.get(terminalId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
            await cleanupTerminal(terminalId);
        }, 2_000);
        localTerminalGcTimers.set(terminalId, timer);
    }

    return true;
}

/** Mark terminal as spawned in Redis. */
export async function markTerminalSpawned(terminalId: string): Promise<void> {
    await updateTerminalFields(terminalId, { spawned: true });
}

/** Remove a terminal viewer socket. */
export async function removeTerminalViewer(terminalId: string, socket: Socket): Promise<void> {
    const viewers = localTerminalViewerSockets.get(terminalId);
    if (viewers) {
        viewers.delete(socket);
        if (viewers.size === 0) {
            localTerminalViewerSockets.delete(terminalId);
        }
    }
    socket.leave(terminalRoom(terminalId));

    // If terminal exited and viewer left, clean up
    const entry = await getTerminalState(terminalId);
    if (entry?.exited) {
        const timer = localTerminalGcTimers.get(terminalId);
        if (timer) clearTimeout(timer);
        await cleanupTerminal(terminalId);
    }
}

/** Get terminal data from Redis. */
export async function getTerminalEntry(terminalId: string): Promise<RedisTerminalData | null> {
    return getTerminalState(terminalId);
}

/** Mark a terminal as exited and schedule cleanup. */
export async function removeTerminal(terminalId: string): Promise<void> {
    const entry = await getTerminalState(terminalId);
    if (!entry) {
        await cleanupTerminal(terminalId);
        return;
    }

    await updateTerminalFields(terminalId, { exited: true });

    const viewers = localTerminalViewerSockets.get(terminalId);
    if (viewers && viewers.size > 0) {
        // Viewer(s) attached — clean up after short delay
        const existingTimer = localTerminalGcTimers.get(terminalId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
            await cleanupTerminal(terminalId);
        }, 2_000);
        localTerminalGcTimers.set(terminalId, timer);
        return;
    }

    // No viewer — keep buffered messages for late viewer, then GC
    const existingTimer = localTerminalGcTimers.get(terminalId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
        log.info(`GC: removing terminal ${terminalId} (no viewer within ${TERMINAL_GC_DELAY_MS}ms)`);
        await cleanupTerminal(terminalId);
    }, TERMINAL_GC_DELAY_MS);
    localTerminalGcTimers.set(terminalId, timer);
}

/** Send data from runner to all terminal viewers. Buffers if no viewer attached. */
export function sendToTerminalViewer(terminalId: string, msg: unknown): void {
    const viewers = localTerminalViewerSockets.get(terminalId);
    if (!viewers || viewers.size === 0) {
        // Buffer for later replay
        const buffer = localTerminalBuffers.get(terminalId);
        if (buffer) {
            buffer.push(msg);
        } else {
            const type = msg && typeof msg === "object" ? (msg as Record<string, unknown>).type : "?";
            log.warn(`sendToTerminalViewer: no entry for ${terminalId} (msg.type=${type}) — dropped`);
        }
        return;
    }

    const msgObj = msg as Record<string, unknown>;
    const eventName = (msgObj.type as string) ?? "terminal_data";
    // Broadcast to all connected viewers (mobile overlay + desktop panel may
    // both be mounted simultaneously with separate sockets).
    for (const viewer of viewers) {
        viewer.emit(eventName, msg);
    }
}

/** Get all terminal IDs for a runner from Redis. */
export async function getTerminalIdsForRunner(runnerId: string): Promise<string[]> {
    const terminals = await getTerminalsForRunnerState(runnerId);
    return terminals.map((t) => t.terminalId);
}

/** Internal cleanup helper — removes all local + Redis state for a terminal. */
async function cleanupTerminal(terminalId: string): Promise<void> {
    const timer = localTerminalGcTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    localTerminalGcTimers.delete(terminalId);
    localTerminalViewerSockets.delete(terminalId);
    localTerminalBuffers.delete(terminalId);
    await deleteTerminalState(terminalId);
}
