/**
 * Module-level server health state.
 *
 * Exported from a dedicated module (not index.ts) to avoid circular imports:
 * index.ts → handler.ts → routes/index.ts would create a cycle if routes
 * imported directly from index.ts.
 */
export const serverHealth = { redis: false, socketio: false, startedAt: Date.now() };

/**
 * Set to `true` when the server receives SIGTERM/SIGINT (graceful shutdown).
 *
 * When true, Socket.IO disconnect handlers MUST skip destructive cleanup
 * (deleting sessions from Redis, removing runner registrations, etc.).
 * The runners and TUI workers are still alive — they will reconnect to the
 * new server instance after the restart.  Destroying their state forces them
 * to fully re-register from scratch and creates a window where sessions
 * appear orphaned / de-registered from their runner.
 */
export let isServerShuttingDown = false;

/** Mark the server as shutting down. Called from SIGTERM/SIGINT handlers. */
export function setServerShuttingDown(): void {
    isServerShuttingDown = true;
}

/**
 * Returns true when socket disconnect handlers should preserve Redis state.
 *
 * During deploy/restart windows, disconnect reasons are not consistently
 * reported as "server shutting down" across transports/adapters. Once we
 * have received a shutdown signal, treat all ensuing disconnects as part of
 * graceful shutdown and preserve state for fast reconnect on the new server.
 */
export function shouldPreserveOnSocketDisconnect(_reason?: string): boolean {
    return isServerShuttingDown;
}

/**
 * Reset the shutdown flag. **Test-only** — allows test suites to restore
 * the default state after exercising shutdown behavior.
 */
export function resetServerShuttingDown(): void {
    isServerShuttingDown = false;
}
