/**
 * Module-level server health state.
 *
 * Exported from a dedicated module (not index.ts) to avoid circular imports:
 * index.ts → handler.ts → routes/index.ts would create a cycle if routes
 * imported directly from index.ts.
 */
export const serverHealth = { redis: false, socketio: false, startedAt: Date.now() };
