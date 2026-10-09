// ============================================================================
// index.ts — sio-registry barrel
//
// Re-exports the full public API of the sio-registry package so that all
// existing callers continue importing from `../sio-registry.js` unchanged.
// ============================================================================

export { initSioRegistry, getIo, runnerRoom, emitToRunner, emitToRelaySession, emitToRelaySessionVerified, emitToRelaySessionChecked, emitToRelaySessionInputAck, hasRelaySessionListener, emitToRelaySessionAwaitingAck, emitToRelaySessionAcked, countSocketsInRoomCluster, runnersUserRoom, broadcastToSessionViewers, serviceFollowRoom, broadcastToServiceFollowers, type RelayEmitCheckResult, type ClusterSocketCount } from "./context.js";
export { broadcastToHub, addHubClient, removeHubClient } from "./hub.js";
export type { RegisterTuiSessionOpts, UpdateSessionStateOpts } from "./sessions.js";
export {
    registerTuiSession,
    getLocalTuiSocket,
    waitForLocalTuiSocket,
    removeLocalTuiSocket,
    forgetLocalTuiSocketIfCurrent,
    getSessions,
    getSharedSession,
    getSharedSessionSummary,
    updateSessionState,
    patchSessionSnapshotState,
    getSessionState,
    touchSessionActivity,
    broadcastSessionEventToViewers,
    publishSessionEvent,
    updateSessionHeartbeat,
    getSessionSeq,
    getSessionLastHeartbeat,
    sendSnapshotToViewer,
    endSharedSession,
    getSessionOwnerToken,
    sweepExpiredSessions,
    sweepOrphanedSessions,
    addViewer,
    removeViewer,
    broadcastToViewers,
    getViewerCount,
    hasVisibleViewer,
    markPendingRecovery,
    consumePendingRecovery,
    hasPendingRecovery,
} from "./sessions.js";
export type { RegisterRunnerOpts } from "./runners.js";
export {
    registerRunner,
    RetryableRunnerRegistrationError,
    updateRunnerSkills,
    updateRunnerAgents,
    updateRunnerPlugins,
    updateRunnerServices,
    getRunnerServices,
    addRunnerWarning,
    clearRunnerWarnings,
    recordRunnerSession,
    linkSessionToRunner,
    removeRunnerSession,
    getConnectedSessionsForRunner,
    getRunners,
    getRunnerData,
    getLocalRunnerSocket,
    forgetLocalRunnerSocketIfCurrent,
    removeRunner,
    touchRunner,
    sweepOrphanedRunners,
} from "./runners.js";
export type { TerminalSpawnOpts } from "./terminals.js";
export {
    registerTerminal,
    setTerminalViewer,
    claimTerminalSpawn,
    removeTerminalViewer,
    getTerminalEntry,
    removeTerminal,
    sendToTerminalViewer,
    getTerminalIdsForRunner,
    getTerminalsForSession,
} from "./terminals.js";
export {
    getSessionMetaState,
    updateSessionMetaState,
    broadcastToSessionMeta,
    extractMetaFromHeartbeat,
    sessionMetaRoom,
} from "./meta.js";
