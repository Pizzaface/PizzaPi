/**
 * Focused hook that owns the UI's session lifecycle state.
 *
 * The reducer inside is the single source of truth for phase, status, error,
 * active session identity, hydration guards, and reconnect tracking.
 * Callers still own the viewer Socket.IO instance and non-lifecycle event
 * handling; this hook provides the lifecycle callbacks and refs needed to
 * keep those handlers in sync without duplicating state.
 */

import * as React from "react";
import type { HubSession } from "@/components/SessionSidebar";
import { mapUserError } from "@/lib/user-error-message";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleActions as lifecycleActions,
  sessionLifecycleReducer,
  type SessionLifecycleAction,
  type SessionLifecycleState,
} from "./session-lifecycle";

export type { SessionLifecycleState } from "./session-lifecycle";

export interface UseSessionLifecycleOptions {
  /** Live sessions from the /hub feed; used to resolve wait-for-live. */
  liveSessions: HubSession[];
  /** Override the default 30s wait-for-live timeout (used in tests). */
  spawnTimeoutMs?: number;
}

export interface SessionLifecycleRefs {
  /** Current lifecycle phase. */
  phase: React.MutableRefObject<SessionLifecycleState["phase"]>;
  /** True while the viewer should ignore streaming deltas. */
  awaitingSnapshot: React.MutableRefObject<boolean>;
  /** True once session_active (non-chunked) or the final chunk is complete. */
  hydrated: React.MutableRefObject<boolean>;
  /** In-flight chunked snapshot state, or null. */
  chunked: React.MutableRefObject<SessionLifecycleState["hydration"]["chunked"]>;
  /** Last completed snapshot id; rejects stale late chunks. */
  lastCompletedSnapshot: React.MutableRefObject<string | null>;
  /** Logical switch generation for stale-event filtering. */
  generation: React.MutableRefObject<number>;
  /** Currently active session id. */
  activeSessionId: React.MutableRefObject<string | null>;
  /** Session id that was disconnected with "Session reconnected" reason. */
  restartPendingSessionId: React.MutableRefObject<string | null>;
}

export interface UseSessionLifecycleResult {
  /** Full lifecycle state (for rendering or derived checks). */
  state: SessionLifecycleState;
  /** Displayed connection status. */
  viewerStatus: string;
  /** True while connecting/hydrating. */
  isHydrating: boolean;
  /** True once the session is live or replay-only. */
  isLive: boolean;
  /** Mutable refs that stay current for socket event handlers. */
  refs: SessionLifecycleRefs;
  /** Raw reducer dispatch for advanced lifecycle updates. */
  dispatch: React.Dispatch<SessionLifecycleAction>;
  /** Update spawn form parameters without starting a spawn. */
  setSpawnParams: (params: {
    runnerId?: string;
    cwd?: string;
    preselectedRunnerId?: string | null;
  }) => void;
  /** Override the displayed status without changing phase (e.g. "Compacting…"). */
  setStatus: (status: React.SetStateAction<string>) => void;
  /** Select / switch to a session. Returns the generation to use for switch_session. */
  openSession: (sessionId: string) => number;
  /** Clear the active session and return to idle. */
  clearSelection: () => void;
  /**
   * Spawn a new session and wait for it to appear in the live session feed.
   * Resolves with the session id once live, or rejects on API failure /
   * timeout so callers can surface it inline.
   */
  spawnSession: (
    runnerId: string,
    cwd: string | undefined,
    agent?: {
      name: string;
      systemPrompt?: string;
      tools?: string;
      disallowedTools?: string;
    },
  ) => Promise<string>;
  /** Lifecycle callback: viewer socket received `connected`. */
  onViewerConnected: (data: {
    replayOnly?: boolean;
    isActive?: boolean;
    meta_source?: "hub";
  }) => void;
  /** Lifecycle callback: viewer socket received `disconnected`. */
  onViewerDisconnected: (data: {
    reason: string;
    /** True when the disconnect was a planned CLI restart. */
    isRestarting?: boolean;
    /** True when the caller has decided not to reconnect. */
    stopReconnect?: boolean;
  }) => void;
  /** Lifecycle callback: viewer socket error or connect_error. */
  onViewerError: (message: string) => void;
  /** Lifecycle callback: session_active (or agent_end) snapshot started arriving. */
  onSnapshotStarted: (payload: {
    chunked?: boolean;
    snapshotId?: string;
    totalMessages?: number;
  }) => void;
  /** Lifecycle callback: chunked hydration progress update. */
  onChunkProgress: (loaded: number, total: number) => void;
  /** Lifecycle callback: snapshot (chunked or non-chunked) is complete and hydrated. */
  onSnapshotComplete: () => void;
  /** Wait for a spawned/resumed session id to appear in the live feed. */
  waitForSessionToGoLive: (sessionId: string, timeoutMs?: number) => Promise<boolean>;
  /** Lifecycle callback: explicit reconnect transition. */
  onReconnecting: () => void;
  /** Lifecycle callback: clear the restart-pending flag (used by internal timeout). */
  onRestartPendingCleared: () => void;
}

const SPAWN_TIMEOUT_MS = 30_000;

export function useSessionLifecycle(
  options: UseSessionLifecycleOptions,
): UseSessionLifecycleResult {
  const { liveSessions, spawnTimeoutMs } = options;
  const liveSessionsRef = React.useRef(liveSessions);
  React.useLayoutEffect(() => {
    liveSessionsRef.current = liveSessions;
  }, [liveSessions]);

  const [state, dispatch] = React.useReducer(
    sessionLifecycleReducer,
    undefined,
    createInitialSessionLifecycleState,
  );

  // Keep refs in sync with state so socket event handlers read current values.
  const phaseRef = React.useRef(state.phase);
  const awaitingSnapshotRef = React.useRef(state.hydration.awaitingSnapshot);
  const hydratedRef = React.useRef(state.hydration.hydrated);
  const chunkedRef = React.useRef(state.hydration.chunked);
  const lastCompletedSnapshotRef = React.useRef(state.hydration.lastCompletedSnapshot);
  const generationRef = React.useRef(state.generation);
  const activeSessionIdRef = React.useRef(state.activeSessionId);
  const restartPendingSessionIdRef = React.useRef(state.reconnect.restartPendingSessionId);

  React.useLayoutEffect(() => {
    phaseRef.current = state.phase;
    awaitingSnapshotRef.current = state.hydration.awaitingSnapshot;
    hydratedRef.current = state.hydration.hydrated;
    chunkedRef.current = state.hydration.chunked;
    lastCompletedSnapshotRef.current = state.hydration.lastCompletedSnapshot;
    generationRef.current = state.generation;
    activeSessionIdRef.current = state.activeSessionId;
    restartPendingSessionIdRef.current = state.reconnect.restartPendingSessionId;
  }, [state]);

  // Wait-for-live waiter registry. Resolved by the liveSessions effect below.
  const waitersRef = React.useRef<
    Map<
      string,
      {
        resolve: (found: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >(new Map());

  React.useEffect(() => {
    for (const [sessionId, waiter] of waitersRef.current) {
      if (liveSessions.some((s: HubSession) => s.sessionId === sessionId)) {
        clearTimeout(waiter.timer);
        waitersRef.current.delete(sessionId);
        waiter.resolve(true);
      }
    }
  }, [liveSessions]);

  const waitForSessionToGoLive = React.useCallback(
    (sessionId: string, timeoutMs = SPAWN_TIMEOUT_MS): Promise<boolean> => {
      if (liveSessionsRef.current.some((s: HubSession) => s.sessionId === sessionId)) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waitersRef.current.delete(sessionId);
          resolve(false);
        }, timeoutMs);
        waitersRef.current.set(sessionId, { resolve, timer });
      });
    },
    [],
  );

  const setSpawnParams = React.useCallback(
    (params: Parameters<UseSessionLifecycleResult["setSpawnParams"]>[0]) => {
      dispatch(lifecycleActions.spawnParamsChanged(params));
    },
    [],
  );

  const setStatus = React.useCallback((status: React.SetStateAction<string>) => {
    dispatch(
      lifecycleActions.statusSet(typeof status === "function" ? status(state.status) : status),
    );
  }, [state.status]);

  const openSession = React.useCallback((sessionId: string): number => {
    const generation = Date.now();
    dispatch(lifecycleActions.sessionSelected(sessionId));
    return generation;
  }, []);

  const clearSelection = React.useCallback(() => {
    for (const waiter of waitersRef.current.values()) {
      clearTimeout(waiter.timer);
    }
    waitersRef.current.clear();
    dispatch(lifecycleActions.cleared());
  }, []);

  const spawnSession = React.useCallback(
    async (
      runnerId: string,
      cwd: string | undefined,
      agent?: {
        name: string;
        systemPrompt?: string;
        tools?: string;
        disallowedTools?: string;
      },
    ): Promise<string> => {
      dispatch(lifecycleActions.spawnRequested(runnerId, cwd));

      const payload: Record<string, unknown> = { runnerId };
      if (cwd) payload.cwd = cwd;
      if (agent) payload.agent = agent;

      const res = await fetch("/api/runners/spawn", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => null)) as {
        error?: string;
        sessionId?: string;
      } | null;

      if (!res.ok) {
        const mapped = mapUserError({
          error: body?.error,
          statusCode: res.status,
          context: "session_spawn",
        });
        dispatch(lifecycleActions.spawnFailed(mapped.userMessage));
        throw new Error(mapped.userMessage);
      }

      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        const mapped = mapUserError({
          error: "Spawn failed: missing sessionId",
          context: "session_spawn",
        });
        dispatch(lifecycleActions.spawnFailed(mapped.userMessage));
        throw new Error(mapped.userMessage);
      }

      dispatch(lifecycleActions.spawnSucceeded(sessionId));
      const live = await waitForSessionToGoLive(sessionId, spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
      if (!live) {
        const message = "Session is starting… (it will appear in the sidebar soon)";
        dispatch(lifecycleActions.spawnFailed(message));
        throw new Error(message);
      }
      return sessionId;
    },
    [waitForSessionToGoLive],
  );

  const onViewerConnected = React.useCallback(
    (data: Parameters<UseSessionLifecycleResult["onViewerConnected"]>[0]) => {
      dispatch(
        lifecycleActions.connected({
          replayOnly: data.replayOnly,
          isActive: data.isActive,
          metaSource: data.meta_source,
        }),
      );
    },
    [],
  );

  const onViewerDisconnected = React.useCallback(
    (data: Parameters<UseSessionLifecycleResult["onViewerDisconnected"]>[0]) => {
      dispatch(
        lifecycleActions.disconnected({
          reason: data.reason,
          isRestarting: data.isRestarting,
          stopReconnect: data.stopReconnect,
        }),
      );
    },
    [],
  );

  const onViewerError = React.useCallback((message: string) => {
    dispatch(lifecycleActions.error(message));
  }, []);

  const onSnapshotStarted = React.useCallback(
    (payload: Parameters<UseSessionLifecycleResult["onSnapshotStarted"]>[0]) => {
      dispatch(
        lifecycleActions.snapshotStarted({
          chunked: payload.chunked,
          snapshotId: payload.snapshotId,
          totalMessages: payload.totalMessages,
        }),
      );
    },
    [],
  );

  const onChunkProgress = React.useCallback((loaded: number, total: number) => {
    dispatch(lifecycleActions.chunkReceived(loaded, total));
  }, []);

  const onSnapshotComplete = React.useCallback(() => {
    dispatch(lifecycleActions.snapshotComplete());
  }, []);

  const onReconnecting = React.useCallback(() => {
    dispatch(lifecycleActions.reconnecting());
  }, []);

  const onRestartPendingCleared = React.useCallback(() => {
    dispatch(lifecycleActions.restartPendingCleared());
  }, []);

  // Auto-clear restart-pending flag after the original 60s window.
  React.useEffect(() => {
    const pendingId = state.reconnect.restartPendingSessionId;
    if (!pendingId) return;
    const timer = setTimeout(() => {
      dispatch(lifecycleActions.restartPendingCleared());
    }, 60_000);
    return () => clearTimeout(timer);
  }, [state.reconnect.restartPendingSessionId]);

  const isHydrating = state.phase === "connecting";
  const isLive = state.phase === "live" || state.phase === "snapshot_replay";

  return {
    state,
    viewerStatus: state.status,
    isHydrating,
    isLive,
    refs: {
      phase: phaseRef,
      awaitingSnapshot: awaitingSnapshotRef,
      hydrated: hydratedRef,
      chunked: chunkedRef,
      lastCompletedSnapshot: lastCompletedSnapshotRef,
      generation: generationRef,
      activeSessionId: activeSessionIdRef,
      restartPendingSessionId: restartPendingSessionIdRef,
    },
    dispatch,
    setSpawnParams,
    setStatus,
    openSession,
    clearSelection,
    spawnSession,
    waitForSessionToGoLive,
    onViewerConnected,
    onViewerDisconnected,
    onViewerError,
    onSnapshotStarted,
    onChunkProgress,
    onSnapshotComplete,
    onReconnecting,
    onRestartPendingCleared,
  };
}
