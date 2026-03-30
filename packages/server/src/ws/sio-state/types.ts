// ============================================================================
// sio-state/types.ts — Data interfaces and TTL constants
// ============================================================================

// ── TTL constants ───────────────────────────────────────────────────────────

/** Default TTL for session keys (24 hours), refreshed on activity. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Default TTL for runner keys (2 hours), refreshed on heartbeat. */
export const RUNNER_TTL_SECONDS = 2 * 60 * 60;

/** Default TTL for terminal keys (1 hour). */
export const TERMINAL_TTL_SECONDS = 60 * 60;

/** TTL for pending runner links (10 minutes). */
export const RUNNER_LINK_TTL_SECONDS = 10 * 60;

/** TTL for index sets — slightly longer than the entity they track. */
export const INDEX_TTL_SECONDS = 25 * 60 * 60;

/** TTL for runner association keys — matches session TTL (24 hours). */
export const RUNNER_ASSOC_TTL_SECONDS = 24 * 60 * 60;

/** 30 days — cleared by addChildSession or TTL expiry */
export const DELINK_MARKER_TTL_SECONDS = 30 * 24 * 3600;

// ── Data interfaces ─────────────────────────────────────────────────────────

export interface RedisSessionData {
    sessionId: string;
    token: string;
    collabMode: boolean;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    userId: string | null;
    userName: string | null;
    sessionName: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    /** JSON-stringified heartbeat payload */
    lastHeartbeat: string | null;
    /** JSON-stringified session state */
    lastState: string | null;
    runnerId: string | null;
    runnerName: string | null;
    seq: number;
    /** ID of the parent session that spawned this one, or null for top-level. */
    parentSessionId: string | null;
    /**
     * Durable "is this a linked child?" signal.
     *
     * Set to the parent session ID when the child first links to a parent.
     * Unlike `parentSessionId`, this is NOT cleared when the parent is
     * transiently offline during a child reconnect — it is only cleared on an
     * explicit delink (delink_children / delink_own_parent) or a cross-user
     * link attempt. Absent on sessions created before this field was added;
     * callers fall back to `parentSessionId` in that case.
     */
    linkedParentId?: string | null;
    /** JSON-stringified SessionMetaState. Written by updateSessionMetaState.
     *  Absent for sessions created before this feature; callers must use
     *  defaultMetaState() as fallback. */
    metaState?: string | null;
}

/**
 * Lightweight subset used for session listings and runner counts.
 * Intentionally excludes `lastState` so list queries never pull multi-MB
 * message snapshots from Redis.
 */
export interface RedisSessionSummaryData {
    sessionId: string;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    userId: string | null;
    userName: string | null;
    sessionName: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    /** JSON-stringified heartbeat payload */
    lastHeartbeat: string | null;
    runnerId: string | null;
    runnerName: string | null;
    parentSessionId: string | null;
}

export interface RedisRunnerData {
    runnerId: string;
    userId: string | null;
    userName: string | null;
    name: string | null;
    /** JSON-stringified string[] */
    roots: string;
    /** JSON-stringified RunnerSkill[] */
    skills: string;
    /** JSON-stringified RunnerAgent[] */
    agents?: string;
    /** JSON-stringified PluginInfo[] — discovered Claude Code plugins */
    plugins?: string;
    /** JSON-stringified RunnerHook[] — active hooks configured on the runner */
    hooks?: string;
    /** Runner CLI version (e.g. "0.1.30") */
    version: string | null;
    /** Node.js process.platform value (e.g. "darwin", "linux", "win32") */
    platform?: string | null;
    /** JSON-stringified string[] — service IDs from last service_announce */
    serviceIds?: string;
    /** JSON-stringified ServicePanelInfo[] — panel metadata from last service_announce */
    panels?: string;
    /** JSON-stringified ServiceTriggerDef[] — trigger defs from last service_announce */
    triggerDefs?: string;
    /** JSON-stringified ServiceSigilDef[] — sigil defs from last service_announce */
    sigilDefs?: string;
    /** JSON-stringified string[] — active warnings from the runner daemon */
    warnings?: string;
}

export interface RedisTerminalData {
    terminalId: string;
    runnerId: string;
    userId: string;
    spawned: boolean;
    exited: boolean;
    /** JSON-stringified TerminalSpawnOpts */
    spawnOpts: string;
}
