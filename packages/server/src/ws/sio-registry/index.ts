// ============================================================================
// index.ts — sio-registry barrel
//
// Re-exports the full public API of the sio-registry package so that all
// existing callers continue importing from `../sio-registry.js` unchanged.
// ============================================================================

export { initSioRegistry, emitToRunner, emitToRelaySession, emitToRelaySessionVerified } from "./context.js";
export { broadcastToHub, addHubClient, removeHubClient } from "./hub.js";
export type { RegisterTuiSessionOpts } from "./sessions.js";
export {
    registerTuiSession,
    getLocalTuiSocket,
    removeLocalTuiSocket,
    getSessions,
    getSharedSession,
    updateSessionState,
    getSessionState,
    touchSessionActivity,
    broadcastSessionEventToViewers,
    publishSessionEvent,
    updateSessionHeartbeat,
    getSessionSeq,
    getSessionLastHeartbeat,
    sendSnapshotToViewer,
    endSharedSession,
    sweepExpiredSessions,
    sweepOrphanedSessions,
    addViewer,
    removeViewer,
    broadcastToViewers,
    getViewerCount,
} from "./sessions.js";
export type { RegisterRunnerOpts } from "./runners.js";
export {
    registerRunner,
    updateRunnerSkills,
    updateRunnerAgents,
    updateRunnerPlugins,
    recordRunnerSession,
    linkSessionToRunner,
    removeRunnerSession,
    getConnectedSessionsForRunner,
    getRunners,
    getRunnerData,
    getLocalRunnerSocket,
    removeRunner,
    touchRunner,
} from "./runners.js";
export type { TerminalSpawnOpts } from "./terminals.js";
export {
    registerTerminal,
    setTerminalViewer,
    markTerminalSpawned,
    removeTerminalViewer,
    getTerminalEntry,
    removeTerminal,
    sendToTerminalViewer,
    getTerminalIdsForRunner,
} from "./terminals.js";
