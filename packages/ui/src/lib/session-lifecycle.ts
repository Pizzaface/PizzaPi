/**
 * Pure, React-agnostic session lifecycle state machine.
 *
 * Owns phase, status, error, and the active session identity for the
 * spawn / register / connect / hydrate / live / replay / reconnect / error
 * lifecycle. All other state (messages, models, panels, pending questions)
 * lives outside this reducer.
 */

export type SessionLifecyclePhase =
  | "idle"
  | "spawning"
  | "registering"
  | "connecting"
  | "snapshot_replay"
  | "live"
  | "reconnecting"
  | "error";
// Note: "hydrating" is intentionally folded into "connecting"; use the
// hydration flags to distinguish awaiting-snapshot vs chunked-loading.

export interface ChunkedDeliveryState {
  snapshotId: string;
  totalMessages: number;
  totalChunks: number;
  receivedChunkIndexes: Set<number>;
  finalChunkSeen: boolean;
  loadedMessages: number;
  chunkBuffer: Map<number, unknown[]>;
}

export interface SessionLifecycleState {
  /** Canonical lifecycle phase for the active session. */
  phase: SessionLifecyclePhase;
  /** Human-readable connection status derived from the phase and events. */
  status: string;
  /** Terminal or retryable error message, if any. */
  error: string | null;
  /** Currently focused relay session id, or null when none is selected. */
  activeSessionId: string | null;
  /** Logical switch generation used to ignore stale viewer events. */
  generation: number;
  /** Spawn form + in-flight spawn state. */
  spawn: {
    runnerId: string | undefined;
    cwd: string;
    preselectedRunnerId: string | null;
    /** Session id returned by a successful spawn API call while we wait for it to go live. */
    pendingSessionId: string | null;
    /** Error from the spawn API or wait-for-live timeout. */
    error: string | null;
  };
  /** Hydration guard state — snapshot/chunk delivery tracking. */
  hydration: {
    /** True between session selection and the first state-setting snapshot. */
    awaitingSnapshot: boolean;
    /** True once session_active (non-chunked) or the final chunk has been processed. */
    hydrated: boolean;
    /** True when meta state for this session is authoritative from the hub namespace. */
    metaSourceHub: boolean;
    /** In-flight chunked snapshot state, or null when not chunking. */
    chunked: ChunkedDeliveryState | null;
    /** Snapshot id of the most recently completed snapshot; rejects stale late chunks. */
    lastCompletedSnapshot: string | null;
  };
  /** Reconnect tracking for CLI restarts / transient disconnects. */
  reconnect: {
    /** Session id that was disconnected with "Session reconnected" reason. */
    restartPendingSessionId: string | null;
  };
}

export interface SessionLifecycleActions {
  /** Begin a new spawn request. */
  spawnRequested: (runnerId: string | undefined, cwd: string | undefined) => SessionLifecycleAction;
  /** Spawn API returned a session id; wait for it to register as live. */
  spawnSucceeded: (sessionId: string) => SessionLifecycleAction;
  /** Spawn API failed or wait-for-live timed out. */
  spawnFailed: (error: string) => SessionLifecycleAction;
  /** Update spawn form parameters without starting a spawn. */
  spawnParamsChanged: (params: {
    runnerId?: string;
    cwd?: string;
    preselectedRunnerId?: string | null;
  }) => SessionLifecycleAction;
  /** User selected / switched to a session. */
  sessionSelected: (sessionId: string) => SessionLifecycleAction;
  /** Viewer socket confirmed connection to the active session. */
  connected: (payload?: {
    replayOnly?: boolean;
    isActive?: boolean;
    metaSource?: "hub";
  }) => SessionLifecycleAction;
  /** Viewer socket disconnected. */
  disconnected: (payload: {
    reason: string;
    isRestarting?: boolean;
    stopReconnect?: boolean;
  }) => SessionLifecycleAction;
  /** Explicit reconnect transition (e.g. after a deliberate socket reconnect). */
  reconnecting: () => SessionLifecycleAction;
  /** Clear the CLI-restart pending flag after the timeout window expires. */
  restartPendingCleared: () => SessionLifecycleAction;
  /** State-setting snapshot (session_active / agent_end) started arriving. */
  snapshotStarted: (payload?: {
    chunked?: boolean;
    snapshotId?: string;
    totalMessages?: number;
  }) => SessionLifecycleAction;
  /** Chunked hydration progress update. */
  chunkReceived: (loaded: number, total: number) => SessionLifecycleAction;
  /** Snapshot (chunked or not) is complete and the session is hydrated. */
  snapshotComplete: () => SessionLifecycleAction;
  /** Lifecycle-level error (e.g. viewer socket error). */
  error: (message: string) => SessionLifecycleAction;
  /** Override the displayed status without changing phase (e.g. "Compacting…"). */
  statusSet: (status: string) => SessionLifecycleAction;
  /** Clear the active session and return to idle. */
  cleared: () => SessionLifecycleAction;
}

export type SessionLifecycleAction =
  | { type: "SPAWN_REQUESTED"; runnerId: string | undefined; cwd: string | undefined }
  | { type: "SPAWN_SUCCEEDED"; sessionId: string }
  | { type: "SPAWN_FAILED"; error: string }
  | { type: "SPAWN_PARAMS_CHANGED"; runnerId?: string; cwd?: string; preselectedRunnerId?: string | null }
  | { type: "SESSION_SELECTED"; sessionId: string; generation: number }
  | { type: "CONNECTED"; replayOnly?: boolean; isActive?: boolean; metaSource?: "hub" }
  | { type: "DISCONNECTED"; reason: string; isRestarting?: boolean; stopReconnect?: boolean }
  | { type: "RECONNECTING" }
  | { type: "RESTART_PENDING_CLEARED" }
  | { type: "SNAPSHOT_STARTED"; chunked?: boolean; snapshotId?: string; totalMessages?: number }
  | { type: "CHUNK_RECEIVED"; loaded: number; total: number }
  | { type: "SNAPSHOT_COMPLETE" }
  | { type: "ERROR"; error: string }
  | { type: "STATUS_SET"; status: string }
  | { type: "CLEARED" };

export const sessionLifecycleActions: SessionLifecycleActions = {
  spawnRequested: (runnerId, cwd) => ({
    type: "SPAWN_REQUESTED",
    runnerId,
    cwd: cwd ?? "",
  }),
  spawnSucceeded: (sessionId) => ({ type: "SPAWN_SUCCEEDED", sessionId }),
  spawnFailed: (error) => ({ type: "SPAWN_FAILED", error }),
  spawnParamsChanged: (params) => ({ type: "SPAWN_PARAMS_CHANGED", ...params }),
  sessionSelected: (sessionId) => ({
    type: "SESSION_SELECTED",
    sessionId,
    generation: Date.now(), // logical generation; hook may override
  }),
  connected: (payload = {}) => ({ type: "CONNECTED", ...payload }),
  disconnected: (payload) => ({ type: "DISCONNECTED", ...payload }),
  reconnecting: () => ({ type: "RECONNECTING" }),
  restartPendingCleared: () => ({ type: "RESTART_PENDING_CLEARED" }),
  snapshotStarted: (payload = {}) => ({ type: "SNAPSHOT_STARTED", ...payload }),
  chunkReceived: (loaded, total) => ({ type: "CHUNK_RECEIVED", loaded, total }),
  snapshotComplete: () => ({ type: "SNAPSHOT_COMPLETE" }),
  error: (error) => ({ type: "ERROR", error }),
  statusSet: (status) => ({ type: "STATUS_SET", status }),
  cleared: () => ({ type: "CLEARED" }),
};

function makeIdleState(): SessionLifecycleState {
  return {
    phase: "idle",
    status: "Idle",
    error: null,
    activeSessionId: null,
    generation: 0,
    spawn: {
      runnerId: undefined,
      cwd: "",
      preselectedRunnerId: null,
      pendingSessionId: null,
      error: null,
    },
    hydration: {
      awaitingSnapshot: false,
      hydrated: false,
      metaSourceHub: false,
      chunked: null,
      lastCompletedSnapshot: null,
    },
    reconnect: {
      restartPendingSessionId: null,
    },
  };
}

function isTransientStatusPreservedOnSnapshotComplete(status: string): boolean {
  return (
    status === "Model set" ||
    status === "Compacting…" ||
    status.startsWith("Compacted")
  );
}

function isLifecycleStatus(status: string): boolean {
  return (
    status === "Idle" ||
    status === "Spawning session…" ||
    status === "Registering session…" ||
    status === "Connecting…" ||
    status === "Snapshot replay" ||
    status === "Connected" ||
    status.startsWith("Loading session") ||
    status === "Restarting CLI…" ||
    status === "Disconnected" ||
    status.startsWith("Session is starting")
  );
}

export function sessionLifecycleReducer(
  state: SessionLifecycleState,
  action: SessionLifecycleAction,
): SessionLifecycleState {
  switch (action.type) {
    case "SPAWN_REQUESTED": {
      return {
        ...state,
        phase: "spawning",
        status: "Spawning session…",
        error: null,
        spawn: {
          ...state.spawn,
          runnerId: action.runnerId,
          cwd: action.cwd ?? "",
          pendingSessionId: null,
          error: null,
        },
      };
    }

    case "SPAWN_SUCCEEDED": {
      if (state.phase !== "spawning") return state;
      return {
        ...state,
        phase: "registering",
        status: "Session is starting…",
        spawn: {
          ...state.spawn,
          pendingSessionId: action.sessionId,
          error: null,
        },
      };
    }

    case "SPAWN_FAILED": {
      return {
        ...state,
        phase: "error",
        status: action.error,
        error: action.error,
        spawn: {
          ...state.spawn,
          error: action.error,
        },
      };
    }

    case "SPAWN_PARAMS_CHANGED": {
      return {
        ...state,
        spawn: {
          ...state.spawn,
          runnerId: action.runnerId ?? state.spawn.runnerId,
          cwd: action.cwd ?? state.spawn.cwd,
          preselectedRunnerId:
            action.preselectedRunnerId === undefined
              ? state.spawn.preselectedRunnerId
              : action.preselectedRunnerId,
        },
      };
    }

    case "SESSION_SELECTED": {
      return {
        ...makeIdleState(),
        phase: "connecting",
        status: "Connecting…",
        activeSessionId: action.sessionId,
        generation: action.generation,
        spawn: {
          ...makeIdleState().spawn,
          runnerId: state.spawn.runnerId,
          cwd: state.spawn.cwd,
          preselectedRunnerId: state.spawn.preselectedRunnerId,
        },
        hydration: {
          ...makeIdleState().hydration,
          awaitingSnapshot: true,
        },
      };
    }

    case "CONNECTED": {
      if (!state.activeSessionId) return state;
      const replayOnly = action.replayOnly === true;
      return {
        ...state,
        phase: replayOnly ? "snapshot_replay" : "connecting",
        status: replayOnly ? "Snapshot replay" : "Connected",
        error: null,
        hydration: {
          ...state.hydration,
          awaitingSnapshot: !replayOnly,
          hydrated: replayOnly,
          metaSourceHub: action.metaSource === "hub" || state.hydration.metaSourceHub,
        },
      };
    }

    case "DISCONNECTED": {
      if (!state.activeSessionId) return state;

      const isRestarting = action.isRestarting === true;
      const stopReconnect = action.stopReconnect === true;

      if (stopReconnect) {
        return {
          ...state,
          phase: "error",
          status: action.reason || "Disconnected",
          error: action.reason || "Disconnected",
          reconnect: {
            restartPendingSessionId: null,
          },
        };
      }

      return {
        ...state,
        phase: isRestarting ? "reconnecting" : "error",
        status: isRestarting ? "Restarting CLI…" : (action.reason || "Disconnected"),
        error: isRestarting ? null : (action.reason || "Disconnected"),
        reconnect: {
          restartPendingSessionId: isRestarting ? state.activeSessionId : null,
        },
      };
    }

    case "RECONNECTING": {
      if (!state.activeSessionId) return state;
      return {
        ...state,
        phase: "reconnecting",
        status: "Restarting CLI…",
        error: null,
      };
    }

    case "RESTART_PENDING_CLEARED": {
      if (state.reconnect.restartPendingSessionId === null) return state;
      return {
        ...state,
        reconnect: {
          restartPendingSessionId: null,
        },
      };
    }

    case "SNAPSHOT_STARTED": {
      if (!state.activeSessionId) return state;
      const isChunked = action.chunked === true;
      const totalMessages = typeof action.totalMessages === "number" ? action.totalMessages : 0;

      if (isChunked) {
        return {
          ...state,
          phase: "connecting",
          status: `Loading session (0 of ${totalMessages} messages)…`,
          hydration: {
            ...state.hydration,
            awaitingSnapshot: false,
            hydrated: false,
            chunked: {
              snapshotId: action.snapshotId ?? "",
              totalMessages,
              totalChunks: 0,
              receivedChunkIndexes: new Set(),
              finalChunkSeen: false,
              loadedMessages: 0,
              chunkBuffer: new Map(),
            },
            lastCompletedSnapshot: null,
          },
        };
      }

      return {
        ...state,
        phase: state.phase === "snapshot_replay" ? "snapshot_replay" : "connecting",
        status: state.phase === "snapshot_replay" ? "Snapshot replay" : "Connected",
        hydration: {
          ...state.hydration,
          awaitingSnapshot: false,
          hydrated: false,
          chunked: null,
          lastCompletedSnapshot: "non-chunked",
        },
      };
    }

    case "CHUNK_RECEIVED": {
      if (!state.hydration.chunked) return state;
      return {
        ...state,
        phase: "connecting",
        status: `Loading session (${Math.min(action.loaded, action.total)} of ${action.total} messages)…`,
        hydration: {
          ...state.hydration,
          chunked: {
            ...state.hydration.chunked,
            loadedMessages: action.loaded,
          },
        },
      };
    }

    case "SNAPSHOT_COMPLETE": {
      if (!state.activeSessionId) return state;
      return {
        ...state,
        phase: "live",
        status: isTransientStatusPreservedOnSnapshotComplete(state.status) ? state.status : "Connected",
        error: null,
        hydration: {
          ...state.hydration,
          awaitingSnapshot: false,
          hydrated: true,
          chunked: null,
          lastCompletedSnapshot: state.hydration.chunked?.snapshotId ?? state.hydration.lastCompletedSnapshot,
        },
      };
    }

    case "ERROR": {
      return {
        ...state,
        phase: "error",
        status: action.error,
        error: action.error,
      };
    }

    case "STATUS_SET": {
      return {
        ...state,
        status: action.status,
      };
    }

    case "CLEARED": {
      return {
        ...makeIdleState(),
        spawn: {
          ...makeIdleState().spawn,
          runnerId: state.spawn.runnerId,
          cwd: state.spawn.cwd,
          preselectedRunnerId: state.spawn.preselectedRunnerId,
        },
      };
    }

    default:
      return state;
  }
}

// Selectors

export function isSessionHydratingState(state: SessionLifecycleState): boolean {
  return state.phase === "connecting";
}

export function isSessionLiveState(state: SessionLifecycleState): boolean {
  return state.phase === "live" || state.phase === "snapshot_replay";
}

export function canSubmitSessionInputState(state: SessionLifecycleState): boolean {
  return state.activeSessionId !== null && state.phase === "live";
}

export function getSessionEmptyState(state: SessionLifecycleState): {
  title: string;
  description: string;
  shouldSpinLogo: boolean;
} {
  if (isSessionHydratingState(state)) {
    return {
      title: "Loading session",
      description: "Fetching conversation data…",
      shouldSpinLogo: true,
    };
  }
  return {
    title: "Waiting for session events",
    description: "Messages will appear here in real time.",
    shouldSpinLogo: false,
  };
}

/** True if the supplied status is owned by the lifecycle reducer (not a transient override). */
export function isLifecycleStatusText(status: string): boolean {
  return isLifecycleStatus(status);
}

export function createInitialSessionLifecycleState(): SessionLifecycleState {
  return makeIdleState();
}
