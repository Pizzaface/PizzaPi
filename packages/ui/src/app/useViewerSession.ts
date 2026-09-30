import * as React from "react";
import { io } from "socket.io-client";
import { SOCKET_PROTOCOL_VERSION, parseViewerEventEnvelope, parseViewerConnectedEnvelope } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import type { HubSession } from "@/components/SessionSidebar";
import { cancelHaptic } from "@/lib/haptics";
import { logFrontendEvent } from "@/lib/frontend-log";
import { cancelRestoreIntent, createRestoreIntent, takeRestoreTarget, type RestoreIntent } from "@/lib/deep-link-restore";
import { getViewerVisibilityPayload } from "@/lib/viewer-visibility";
import { shouldStopViewerReconnect } from "@/lib/viewer-connection";
import { mapUserError } from "@/lib/user-error-message";
import { attachServiceAnnounceListener, seedServiceCache, setViewerSwitchGeneration } from "@/hooks/useRunnerServices";
import type { TodoItem, SessionUiCacheEntry } from "@/lib/types";
import { normalizeMessages, normalizeSessionName } from "@/lib/message-helpers";
import { touchSessionCache } from "@/lib/session-ui-cache";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import { sessionLifecycleActions as lifecycleActions } from "@/lib/session-lifecycle";
import {
  analyzeIncomingSeq,
  analyzeReplaySeq,
  mergeConnectedSeq,
  shouldAllowOutOfOrderSnapshotDuringHydration,
} from "@/lib/session-seq";
import { isActiveViewerSessionPayload, matchesHydrationGeneration, matchesViewerGeneration, matchesViewerSession, shouldAcceptDisconnected } from "@/lib/viewer-switch";
import {
  HYDRATION_CHECK_INTERVAL_MS,
  HYDRATION_FIRST_RETRY_MS,
  HYDRATION_MAX_RETRIES,
  HYDRATION_STALL_MS,
  STALE_CHECK_INTERVAL_MS,
  UI_VERSION,
} from "./constants";
import { createInitialSessionState, type SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { ArtifactViewerTarget, StateSetter } from "./types";
import type { useStreamingMessages } from "./useStreamingMessages";

const log = createLogger("relay");

export interface ViewerSessionOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycle: UseSessionLifecycleResult;
  streaming: ReturnType<typeof useStreamingMessages>;
  handleRelayEvent: (event: unknown, seq?: number) => void;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  sessionUiCacheRef: React.MutableRefObject<Map<string, SessionUiCacheEntry>>;
  requestedSnapshotMessagesRef: React.MutableRefObject<SessionUiCacheEntry["snapshotMessages"]>;
  liveSessions: HubSession[];
  liveSessionsRef: React.MutableRefObject<HubSession[]>;
  staleThresholdMsRef: React.MutableRefObject<number>;
  socketUrl: (namespace: string) => string;
  buildSocketAuth: (extra: Record<string, unknown>) => Record<string, unknown>;
  setTodoList: StateSetter<TodoItem[]>;
  setPlanModeEnabled: StateSetter<boolean>;
  setIsCompacting: StateSetter<boolean>;
  setAnalysis: StateSetter<SessionUiCacheEntry["analysis"]>;
  setArtifactViewer: StateSetter<ArtifactViewerTarget>;
}

/**
 * The /viewer socket and session switching: `openSession` (restores cached UI
 * state, lazily creates the viewer socket and wires its handlers, hydration
 * stall + stale-connection watchdogs), `clearSelection`, deep-link / last
 * session auto-restore, and auto-reconnect after a remote restart.
 */
export function useViewerSession(options: ViewerSessionOptions) {
  const {
    session: {
      setSessionState, agentActiveRef,
      setViewerSocket, setMessages, setRetryState, setPendingQuestion, setPendingPlan,
      setPendingApproval, setActiveToolCalls, setMcpOAuthPastes, setMessageQueue,
      setActiveModel, setSessionName, setAvailableModels, setIsChangingModel, setAgentActive,
      setEffortLevel, setAuthSource, setTokenUsage, setProviderUsage, setUsageRefreshing,
      setLastHeartbeatAt, setAvailableCommands, setResumeSessions, setResumeSessionsLoading,
      setResumeSessionsNextCursor, setGoal,
    },
    refs: {
      lastSeqRef, lastViewerEventAtRef, staleCheckTimerRef, hydrationRequestedAtRef,
      hydrationStallTimerRef, hydrationRetriesRef, renderedMcpReportTsRef, pendingMcpReportRef,
      injectedMessagesRef, metaSourceHubRef, deferredChunkEventsRef, viewerWsRef,
      paginationStateRef, queueSyncSuppressUntilRef, pendingHydrationInputsRef,
    },
    lifecycle: {
      refs: lifecycleRefs,
      dispatch: lifecycleDispatch,
      setStatus: setLifecycleStatus,
      openSession: lifecycleOpenSession,
      clearSelection: lifecycleClearSelection,
      onViewerConnected,
      onViewerDisconnected,
      onViewerError,
    },
    streaming: { cancelPendingDeltas },
    handleRelayEvent,
    patchSessionCache,
    sessionUiCacheRef,
    requestedSnapshotMessagesRef,
    liveSessions,
    liveSessionsRef,
    staleThresholdMsRef,
    socketUrl,
    buildSocketAuth,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setAnalysis,
    setArtifactViewer,
  } = options;

  const [loadingOlderMessages, setLoadingOlderMessages] = React.useState(false);

  // Auto-reopen the last viewed session once live sessions arrive.
  // If the page was loaded with a /session/<id> URL, that deep-link session ID
  // is captured on mount so it can win over the stored lastSessionId.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const restoreIntentRef = React.useRef<RestoreIntent>(createRestoreIntent(window.location.pathname));

  React.useEffect(() => {
    return () => {
      if (staleCheckTimerRef.current !== null) {
        clearInterval(staleCheckTimerRef.current);
        staleCheckTimerRef.current = null;
      }
      if (hydrationStallTimerRef.current !== null) {
        clearInterval(hydrationStallTimerRef.current);
        hydrationStallTimerRef.current = null;
      }
      viewerWsRef.current?.disconnect();
      viewerWsRef.current = null;
      setViewerSocket(null);
    };
  }, []);

  const clearSelection = React.useCallback(() => {
    if (staleCheckTimerRef.current !== null) {
      clearInterval(staleCheckTimerRef.current);
      staleCheckTimerRef.current = null;
    }
    if (hydrationStallTimerRef.current !== null) {
      clearInterval(hydrationStallTimerRef.current);
      hydrationStallTimerRef.current = null;
    }
    hydrationRequestedAtRef.current = null;
    hydrationRetriesRef.current = 0;
    viewerWsRef.current?.disconnect();
    viewerWsRef.current = null;
    lastSeqRef.current = null;
    renderedMcpReportTsRef.current = null;
    injectedMessagesRef.current = [];
    deferredChunkEventsRef.current = [];
    // Single atomic reset — all session-scoped fields defined in SessionState
    // are cleared together. New fields added to SessionState are automatically
    // included; nothing can be accidentally left stale between sessions.
    setSessionState(createInitialSessionState());
    lifecycleClearSelection();
    // Reset live-status fields that are intentionally outside SessionState
    // (they are driven by heartbeats, not snapshots) but must still be cleared
    // when switching sessions so stale "compacting" / "plan mode" indicators
    // are not carried over until the next heartbeat arrives.
    setIsCompacting(false);
    setPlanModeEnabled(false);
  }, [lifecycleClearSelection]);

  const openSession = React.useCallback((relaySessionId: string) => {
    // Any manual open cancels the pending one-shot deep-link restore intent,
    // so a stale deep-link target going live later can't hijack the session the
    // user opened by hand. The restore effect consumes the intent before
    // calling openSession, so this is a no-op on the legitimate restore path.
    cancelRestoreIntent(restoreIntentRef.current);

    // Already viewing this session AND hydration finished — nothing to do.
    // If hydration never completed, re-clicking the (still highlighted) session
    // is the user's instinctive retry, so it must actually retry rather than
    // no-op and leave them with a blank transcript until a full page reload.
    if (
      relaySessionId === lifecycleRefs.activeSessionId.current &&
      lifecycleRefs.hydrated.current
    ) {
      // awaitingSnapshot alone is not "finished": chunked headers clear it
      // while the transfer is still in flight, and a stalled transfer must
      // remain re-clickable.
      return;
    }

    // Flush/cancel any pending RAF queues (streaming deltas & tool-stream
    // partials) from the previous session so they can't leak into the new one.
    cancelPendingDeltas();

    // Stop any in-flight haptics from the previous session immediately.
    cancelHaptic();

    // Determine if this is a same-runner switch so we can preserve runner-level
    // state (availableModels, availableCommands, providerUsage, authSource).
    // These values are runner-scoped, not session-scoped — resetting them on
    // same-runner switches causes a flash to empty and unnecessary re-renders
    // in the header / model selector.
    const sessions = liveSessionsRef.current;
    const prevSessionId = lifecycleRefs.activeSessionId.current;
    // Session switches cancel queued sends for the old session. Never leave
    // PromptInput awaiting a promise that can no longer be flushed.
    const retainedHydrationInputs = pendingHydrationInputsRef.current.filter((item) => item.sessionId === relaySessionId);
    for (const item of pendingHydrationInputsRef.current) {
      if (item.sessionId !== relaySessionId) item.resolve(false);
    }
    pendingHydrationInputsRef.current = retainedHydrationInputs;
    const prevRunnerId = prevSessionId
      ? sessions.find((s) => s.sessionId === prevSessionId)?.runnerId ?? null
      : null;
    const nextLiveSession = sessions.find((s) => s.sessionId === relaySessionId);
    const nextRunnerId = nextLiveSession?.runnerId ?? null;
    const sameRunner = !!(prevRunnerId && nextRunnerId && prevRunnerId === nextRunnerId);
    const prevViewerSocket = viewerWsRef.current;
    const nextGeneration = lifecycleOpenSession(relaySessionId);

    localStorage.setItem("pp.lastSessionId", relaySessionId);
    lastSeqRef.current = null;
    lastViewerEventAtRef.current = Date.now(); // treat open as an "event" so we don't fire immediately
    renderedMcpReportTsRef.current = null;
    pendingMcpReportRef.current = null;
    injectedMessagesRef.current = [];
    deferredChunkEventsRef.current = [];
    metaSourceHubRef.current = false;
    paginationStateRef.current = null;
    setLoadingOlderMessages(false);
    setRetryState(null);
    setArtifactViewer(null);
    setActiveToolCalls(new Map());
    setMcpOAuthPastes([]);
    setIsChangingModel(false);
    setUsageRefreshing(false);
    setResumeSessions([]);
    setResumeSessionsLoading(false);
    setResumeSessionsNextCursor(null);

    const cached = sessionUiCacheRef.current.get(relaySessionId);
    requestedSnapshotMessagesRef.current = cached?.snapshotMessages;
    touchSessionCache(sessionUiCacheRef.current, relaySessionId);

    // ── Session-scoped state: always reset from cache or defaults ────────
    setMessages(cached?.messages ?? []);
    setActiveModel(cached?.activeModel ?? null);
    setSessionName(cached?.sessionName ?? nextLiveSession?.sessionName ?? null);
    setAgentActive(cached?.agentActive ?? false);
    setIsCompacting(cached?.isCompacting ?? false);
    setEffortLevel(cached?.effortLevel ?? null);
    setPlanModeEnabled(cached?.planModeEnabled ?? false);
    setTokenUsage(cached?.tokenUsage ?? null);
    setLastHeartbeatAt(cached?.lastHeartbeatAt ?? null);
    setTodoList(cached?.todoList ?? []);
    // Reset the queue-sync suppress window — it guards a mutation in the
    // previous session and must not block this session's snapshot sync.
    queueSyncSuppressUntilRef.current = 0;
    setMessageQueue(cached?.messageQueue ?? []);
    setAnalysis(cached?.analysis ?? null);
    setGoal(cached?.goal ?? null);

    // ── Runner-scoped state: preserve on same-runner switch ─────────────
    if (!sameRunner) {
      setAvailableModels(cached?.availableModels ?? []);
      setAvailableCommands(cached?.availableCommands ?? []);
      setAuthSource(cached?.authSource ?? null);
      setProviderUsage(cached?.providerUsage ?? null);
    }

    // Don't restore pendingQuestion/pendingPlan from cache — the cache can be
    // stale if the user answered/rejected before the next heartbeat arrived.
    // The heartbeat (which arrives within seconds) will restore them with
    // authoritative values from the runner.
    setPendingQuestion(null);
    setPendingPlan(null);
    setPendingApproval(null);

    let socket = viewerWsRef.current;
    if (!socket) {
      socket = io(socketUrl("/viewer"), {
        auth: buildSocketAuth({
          protocolVersion: SOCKET_PROTOCOL_VERSION,
          clientVersion: UI_VERSION,
        }),
        withCredentials: true,
        autoConnect: false,
        // WebSocket first (polling fallback) — skips the polling handshake's
        // extra round trips on every connect/reconnect.
        transports: ["websocket", "polling"],
      });
      viewerWsRef.current = socket;
      attachServiceAnnounceListener(socket);
      if (sameRunner) {
        seedServiceCache(socket, prevViewerSocket);
      }
      setViewerSocket(socket);
      const nextSocket = socket;

      // Hydration-stall watchdog: a hydration request is fire-and-forget, so a
      // reply that carries no transcript (or never arrives) leaves the viewer
      // waiting forever with input blocked. Retry once with no cursor, which
      // forces the server down its full-snapshot path.
      hydrationStallTimerRef.current = setInterval(() => {
        const sessionId = lifecycleRefs.activeSessionId.current;
        if (!sessionId || !nextSocket.connected) return;
        // A chunked transfer clears awaitingSnapshot on the chunk *header*, so
        // the transfer itself must keep the watchdog armed — a stream that
        // stops mid-way (dropped frame, runner crash) would otherwise freeze
        // "Loading session (x of y)…" forever with no retry. Arriving chunks
        // reset hydrationRequestedAtRef, so a progressing transfer never trips.
        const chunkInFlight =
          lifecycleRefs.chunked.current !== null && !lifecycleRefs.hydrated.current;
        if (!lifecycleRefs.awaitingSnapshot.current && !chunkInFlight) {
          hydrationRequestedAtRef.current = null;
          hydrationRetriesRef.current = 0;
          return;
        }
        const requestedAt = hydrationRequestedAtRef.current;
        if (requestedAt === null) return;
        const stallThreshold = hydrationRetriesRef.current === 0 ? HYDRATION_FIRST_RETRY_MS : HYDRATION_STALL_MS;
        if (Date.now() - requestedAt < stallThreshold) return;

        if (hydrationRetriesRef.current >= HYDRATION_MAX_RETRIES) {
          // Stop retrying, but never leave a spinner claiming progress.
          hydrationRequestedAtRef.current = null;
          onViewerError("Could not load this conversation. Reload to try again.");
          return;
        }

        hydrationRetriesRef.current += 1;
        log.warn(
          `Hydration stalled for ${sessionId} (attempt ${hydrationRetriesRef.current}/${HYDRATION_MAX_RETRIES}); retrying without a seq cursor.`,
        );
        hydrationRequestedAtRef.current = Date.now();
        // Drop the cursor so the server takes its full-snapshot path instead of
        // trying to resume from a position it cannot serve.
        lastSeqRef.current = null;
        nextSocket.emit("switch_session", {
          sessionId,
          generation: lifecycleRefs.generation.current,
        });
      }, HYDRATION_CHECK_INTERVAL_MS);

      // Stale-connection watchdog: if the socket thinks it's connected but
      // no event has arrived for the current visibility-aware threshold, reconnect.
      // Armed while the agent is active (events are expected, so silence is
      // suspicious) and also while hydrating (a dead transport is exactly why a
      // transcript never arrives). Idle, hydrated sessions are legitimately silent.
      staleCheckTimerRef.current = setInterval(() => {
        if (!lifecycleRefs.activeSessionId.current) return;
        if (!nextSocket.connected) return;
        const chunkTransferInFlight =
          lifecycleRefs.chunked.current !== null && !lifecycleRefs.hydrated.current;
        if (!agentActiveRef.current && !lifecycleRefs.awaitingSnapshot.current && !chunkTransferInFlight) return;
        const elapsed = Date.now() - lastViewerEventAtRef.current;
        if (elapsed > staleThresholdMsRef.current) {
          log.warn(`Stale connection detected (${Math.round(elapsed / 1000)}s since last event). Reconnecting…`);
          nextSocket.disconnect();
          nextSocket.connect();
        }
      }, STALE_CHECK_INTERVAL_MS);

      nextSocket.on("connect", () => {
        const currentSessionId = lifecycleRefs.activeSessionId.current;
        if (!currentSessionId) return;
        // A transport reconnect on an already-hydrated session must not flip the
        // status back to "Connecting…": the composer gate and the "still
        // connecting" banner key off the status STRING, so re-arming it here
        // shows a scary offline banner on a session that is visibly fine every
        // time a mobile tab backgrounds or WiFi blips. The reducer's CONNECTED
        // action already keeps hydrated reconnects live; mirror that here.
        if (!lifecycleRefs.hydrated.current) {
          setLifecycleStatus("Connecting…");
        }
        setViewerSwitchGeneration(nextSocket, lifecycleRefs.generation.current);
        hydrationRequestedAtRef.current = Date.now();
        hydrationRetriesRef.current = 0;
        nextSocket.emit("switch_session", {
          sessionId: currentSessionId,
          generation: lifecycleRefs.generation.current,
          lastSeq: lastSeqRef.current ?? undefined,
          messagesHash: requestedSnapshotMessagesRef.current?.hash ?? "",
        });
        nextSocket.emit("viewer_visibility", getViewerVisibilityPayload());
      });

      nextSocket.on("connected", (data) => {
        const envelope = parseViewerConnectedEnvelope(data);
        if (!envelope.ok) {
          logFrontendEvent("viewer", "warning", "Malformed viewer connected envelope", envelope.error);
          return;
        }
        const payload = envelope.value;
        if (!isActiveViewerSessionPayload(
          lifecycleRefs.activeSessionId.current,
          payload.sessionId,
          lifecycleRefs.generation.current,
          payload.generation,
        )) {
          return;
        }
        lastViewerEventAtRef.current = Date.now();

        metaSourceHubRef.current = payload.meta_source === "hub";
        onViewerConnected({
          replayOnly: payload.replayOnly,
          isActive: payload.isActive,
          meta_source: payload.meta_source,
        });

        if (typeof payload.lastSeq === "number") {
          lastSeqRef.current = mergeConnectedSeq(lastSeqRef.current, payload.lastSeq);
        }

        if (typeof payload.isActive === "boolean") {
          setAgentActive(payload.isActive);
          patchSessionCache({ agentActive: payload.isActive });
        }

        if (Object.prototype.hasOwnProperty.call(payload, "sessionName")) {
          const nextName = normalizeSessionName(payload.sessionName);
          setSessionName(nextName);
          patchSessionCache({ sessionName: nextName });
        }

        nextSocket.emit("connected", {});
      });

      nextSocket.on("event", (data) => {
        const envelope = parseViewerEventEnvelope(data);
        if (!envelope.ok) {
          logFrontendEvent("viewer", "warning", "Malformed viewer event envelope", envelope.error);
          return;
        }
        const { event: rawEvent, seq: envelopeSeq, deltaReplay, generation, sessionId: envelopeSessionId } = envelope.value;

        // Session-stamped envelopes from another session are cross-session
        // bleed (in-flight old-room broadcasts during a tab switch) — drop
        // them before the generation/hydration checks can accept them.
        if (!matchesViewerSession(lifecycleRefs.activeSessionId.current, envelopeSessionId)) {
          return;
        }

        const eventType =
          rawEvent && typeof rawEvent === "object" && typeof (rawEvent as Record<string, unknown>).type === "string"
            ? (rawEvent as Record<string, unknown>).type as string
            : "";

        // Direct hydration events carry the switch generation. A cache-miss
        // recovery snapshot is instead broadcast through the new session room,
        // so its session_active header has no generation. The server has already
        // removed this socket from the old room before joining the new one; accept
        // only that state-setting header while awaiting hydration.
        if (!matchesHydrationGeneration(
          lifecycleRefs.generation.current,
          generation,
          eventType,
          lifecycleRefs.awaitingSnapshot.current,
        )) {
          return;
        }
        if (!lifecycleRefs.activeSessionId.current) return;
        lastViewerEventAtRef.current = Date.now();

        const seq = envelopeSeq ?? null;
        if (seq !== null) {
          if (deltaReplay === true) {
            // Only advance the cursor when the replayed seq is strictly newer.
            // Stale cached deltas emitted by the resync endpoint (seq <= cursor)
            // are dropped so they cannot rewind the cursor or reapply old state.
            const replayDecision = analyzeReplaySeq(lastSeqRef.current, seq);
            if (!replayDecision.accept) {
              return;
            }
            lastSeqRef.current = replayDecision.nextSeq;
          } else {
            const allowOutOfOrderHydrationSnapshot = shouldAllowOutOfOrderSnapshotDuringHydration(
              eventType,
              lifecycleRefs.awaitingSnapshot.current,
              lastSeqRef.current,
              seq,
            );
            if (!allowOutOfOrderHydrationSnapshot) {
              const decision = analyzeIncomingSeq(lastSeqRef.current, seq);
              if (!decision.accept) {
                return;
              }
              if (decision.gap && decision.expected !== null) {
                log.warn(`Sequence gap: expected ${decision.expected}, got ${seq}. Requesting resync.`);
                nextSocket.emit("resync", {
                  lastSeq: lastSeqRef.current ?? undefined,
                });
              }
              lastSeqRef.current = decision.nextSeq;
            }
          }
        }

        handleRelayEvent(rawEvent, seq ?? undefined);
      });

      nextSocket.on("session_messages_page", (data) => {
        if (data.sessionId !== lifecycleRefs.activeSessionId.current) return;
        if (!matchesViewerGeneration(lifecycleRefs.generation.current, data.generation)) {
          return;
        }
        lastViewerEventAtRef.current = Date.now();
        const pageMessages = normalizeMessages(Array.isArray(data.messages) ? data.messages : []);
        setMessages((prev) => [...pageMessages, ...prev]);
        paginationStateRef.current = {
          totalMessages: paginationStateRef.current?.totalMessages ?? 0,
          hasMore: data.hasMore,
          oldestLoadedIndex: data.oldestIndex,
        };
        setLoadingOlderMessages(false);
      });

      nextSocket.on("exec_result", (data) => {
        // Drop stale results from a previous session. The relay stamps every
        // forwarded exec_result with the originating sessionId; if it doesn't
        // match the active session, the event arrived late and must be ignored.
        if (!lifecycleRefs.activeSessionId.current) return;
        if (data.sessionId && data.sessionId !== lifecycleRefs.activeSessionId.current) return;
        // Also reject during snapshot acquisition — viewer isn't yet in sync.
        if (lifecycleRefs.awaitingSnapshot.current) return;
        lastViewerEventAtRef.current = Date.now();
        handleRelayEvent({ type: "exec_result", ...data });
      });

      nextSocket.on("disconnected", (data) => {
        if (!shouldAcceptDisconnected(lifecycleRefs.activeSessionId.current, lifecycleRefs.generation.current, data)) {
          return;
        }
        const currentSessionId = lifecycleRefs.activeSessionId.current;
        if (!currentSessionId) return;
        lastViewerEventAtRef.current = Date.now();

        const isRestarting = data.reason === "Session reconnected";
        onViewerDisconnected({
          reason: data.reason,
          isRestarting,
          stopReconnect: shouldStopViewerReconnect(data),
        });

        setPendingQuestion(null);
        setPendingPlan(null);
        setIsChangingModel(false);

        if (shouldStopViewerReconnect(data)) {
          nextSocket.disconnect();
        }
      });

      nextSocket.on("error", (data) => {
        if (!matchesViewerGeneration(lifecycleRefs.generation.current, data.generation)) {
          return;
        }
        if (!lifecycleRefs.activeSessionId.current) return;
        lastViewerEventAtRef.current = Date.now();
        const mapped = mapUserError({
          error: data.message,
          context: "viewer_connection",
          fallbackMessage: "Failed to load session.",
        });
        console.error("Viewer socket error:", mapped.technicalMessage, data);
        onViewerError(mapped.userMessage);
      });

      nextSocket.on("connect_error", (err) => {
        if (lifecycleRefs.activeSessionId.current) {
          const mapped = mapUserError({
            error: err,
            context: "viewer_connection",
          });
          console.error("Viewer socket connect_error:", err);
          onViewerError(mapped.userMessage);
        }
      });

      nextSocket.on("disconnect", (reason) => {
        const sessionId = lifecycleRefs.activeSessionId.current;
        if (!sessionId) return;
        const isRestarting = lifecycleRefs.restartPendingSessionId.current === sessionId;
        onViewerDisconnected({
          reason: isRestarting ? "Session reconnected" : "Disconnected",
          isRestarting,
        });
        setPendingQuestion(null);
        setPendingPlan(null);
        setIsChangingModel(false);
        lastViewerEventAtRef.current = Date.now();

        if (reason === "io server disconnect") {
          setTimeout(() => {
            if (lifecycleRefs.activeSessionId.current && !nextSocket.connected) {
              nextSocket.connect();
            }
          }, 2000);
        }
      });
    }

    if (!socket) return;

    setViewerSwitchGeneration(socket, nextGeneration);
    if (socket.connected) {
      hydrationRequestedAtRef.current = Date.now();
      hydrationRetriesRef.current = 0;
      socket.emit("switch_session", {
        sessionId: relaySessionId, generation: nextGeneration,
        messagesHash: requestedSnapshotMessagesRef.current?.hash ?? "",
      });
      socket.emit("viewer_visibility", getViewerVisibilityPayload());
    } else {
      socket.connect();
    }
  }, [handleRelayEvent, patchSessionCache, cancelPendingDeltas, lifecycleOpenSession, onViewerConnected, onViewerDisconnected, onViewerError]);

  // Auto-reopen the last viewed session once live sessions arrive.
  // Deep-links (/session/<id>) take priority over the stored lastSessionId.
  React.useEffect(() => {
    const hit = takeRestoreTarget(
      restoreIntentRef.current,
      liveSessions.map((s) => s.sessionId),
      localStorage.getItem("pp.lastSessionId"),
    );
    if (!hit) return;
    // A deep-link URL was consumed — replace it so a reload doesn't
    // re-trigger the deep-link.
    if (hit.wasDeepLink) history.replaceState(null, "", "/");
    openSession(hit.targetId);
  }, [liveSessions, openSession]);

  // When a restarted session comes back live, automatically reconnect to it.
  React.useEffect(() => {
    const pendingId = lifecycleRefs.restartPendingSessionId.current;
    if (!pendingId) return;
    const isLive = liveSessions.some((s) => s.sessionId === pendingId);
    if (!isLive) return;

    // Clear the pending restart state before reconnecting.
    lifecycleDispatch(lifecycleActions.restartPendingCleared());
    openSession(pendingId);
  }, [liveSessions, openSession, lifecycleDispatch]);

  return { openSession, clearSelection, loadingOlderMessages, setLoadingOlderMessages };
}
