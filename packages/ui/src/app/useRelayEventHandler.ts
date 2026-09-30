import * as React from "react";
import type { MetaGoalStatus } from "@pizzapi/protocol";
import type { RelayMessage } from "@/components/SessionViewer";
import { detectInFlightTools } from "@/components/session-viewer/utils";
import type { ProviderUsageMap } from "@/components/UsageIndicator";
import { pulseStreamingHaptic, cancelHaptic, startToolHaptic, stopToolHaptic } from "@/lib/haptics";
import { parsePendingQuestionDisplayMode, parsePendingQuestions } from "@/lib/ask-user-questions";
import type { TodoItem, SessionUiCacheEntry } from "@/lib/types";
import { deriveSessionMetadataUpdatePatch } from "@/lib/session-metadata-update";
import {
  toRelayMessage,
  deduplicateMessages,
  normalizeMessages,
  normalizeModel,
  normalizeSessionName,
  augmentThinkingDurations,
  normalizeModelList,
  normalizeCommandList,
  buildStreamingPartialMessage,
} from "@/lib/message-helpers";
import { resolveSnapshotMessages } from "@/lib/session-ui-cache";
import { removeMessagesByStableKey, replaceMessageByStableKey } from "@/lib/mcp-auth-banners";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import {
  canFinalizeChunkHydration,
  registerChunkIndex,
  shouldDeferEventForHydration,
  shouldRequestChunkRecovery,
} from "@/lib/session-seq";
import type { SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { ArtifactViewerTarget, StateSetter } from "./types";
import type { useStreamingMessages } from "./useStreamingMessages";
import type { useSessionMetaAppliers } from "./useSessionMetaAppliers";
import {
  appendUniqueResumeSessions,
  buildMcpCommandResult,
  formatCompactSummary,
  parseForkMessageList,
  parseResumeSessionList,
} from "./exec-result-parsers";
import { parsePlanModeSource } from "./pending-plan";
import { withSetMember } from "./session-cache-entry";

export interface RelayEventHandlerOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycle: UseSessionLifecycleResult;
  streaming: ReturnType<typeof useStreamingMessages>;
  appliers: ReturnType<typeof useSessionMetaAppliers>;
  requestedSnapshotMessagesRef: React.MutableRefObject<SessionUiCacheEntry["snapshotMessages"]>;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  setTodoList: StateSetter<TodoItem[]>;
  setPlanModeEnabled: StateSetter<boolean>;
  setIsCompacting: StateSetter<boolean>;
  setAnalysis: StateSetter<SessionUiCacheEntry["analysis"]>;
  setSessionsCompacting: StateSetter<Set<string>>;
  setArtifactViewer: StateSetter<ArtifactViewerTarget>;
}

/**
 * The viewer relay event reducer: applies one relay event (heartbeat,
 * snapshot, chunk, streaming delta, tool lifecycle, exec_result, MCP auth, …)
 * to viewer state and the per-session UI cache.
 *
 * Returns a single callback whose identity only changes when its listed
 * dependencies do (the socket wiring re-binds on change).
 */
export function useRelayEventHandler(options: RelayEventHandlerOptions) {
  const {
    session: {
      sessionState: { activeModel },
      messagesRef,
      activeModelRef,
      setMessages, setRetryState, setPendingQuestion, setPendingPlan, setPendingApproval,
      setPluginTrustPrompt, setActiveToolCalls, setMcpOAuthPastes, setMessageQueue,
      setActiveModel, setSessionName, setAvailableModels, setIsChangingModel, setAgentActive,
      setEffortLevel, setProviderUsage, setUsageRefreshing, setLastHeartbeatAt,
      setAvailableCommands, setResumeSessions, setResumeSessionsLoading,
      setResumeSessionsNextCursor, setGoal, setForkMessages, setForkMessagesLoading,
    },
    refs: {
      deferredChunkEventsRef, metaSourceHubRef, viewerWsRef, hydrationRequestedAtRef,
      injectedMessagesRef, paginationStateRef, pendingMcpReportRef, handleUiNotifyRef,
      resumeSessionsFallbackTimerRef, resumeSessionsAppendRef,
    },
    lifecycle: {
      refs: lifecycleRefs,
      setStatus: setLifecycleStatus,
      onSnapshotStarted,
      onSnapshotComplete,
      onChunkProgress,
      onViewerDisconnected,
    },
    streaming: {
      pendingToolStreamRef, toolStreamRafRef, thinkingStartTimesRef, thinkingDurationsRef,
      cancelPendingDeltas, upsertMessage, upsertMessageDebounced, scheduleToolStreamFlush,
    },
    appliers: {
      getFallbackPromptKey, appendLocalSystemMessage, removeQueuedMessageByContent,
      applyQueuedMessagesSync, applyMcpReport,
    },
    requestedSnapshotMessagesRef,
    patchSessionCache,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setAnalysis,
    setSessionsCompacting,
    setArtifactViewer,
  } = options;

  const handleRelayEvent = React.useCallback((event: unknown, _seq?: number) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    // Clear the snapshot guard when we receive a state-setting event.
    // These events replace the entire message list, so any pre-snapshot
    // deltas that snuck through are harmless (they'll be overwritten).
    // NOTE: heartbeat must NOT clear this flag — the server sends heartbeat
    // before addViewer() completes (viewer.ts:383-395), so clearing on HB
    // would drop the guard before the viewer is in the room, allowing
    // in-flight chunks or deltas to be accepted and then overwritten by
    // the later snapshot header.
    // session_active handles its own snapshot start via onSnapshotStarted.
    if (type === "agent_end") {
      onSnapshotStarted({});
    }

    // Deltas cannot be applied on top of a half-loaded snapshot. Drop them
    // before the header, but retain them during chunking for replay after the
    // atomic swap. The same helper also rejects chunks seen before their header.
    if (shouldDeferEventForHydration(
      type,
      lifecycleRefs.awaitingSnapshot.current,
      !!lifecycleRefs.chunked.current,
    )) {
      if (lifecycleRefs.chunked.current) deferredChunkEventsRef.current.push(event);
      return;
    }

    if (type === "heartbeat") {
      const hb = evt as {
        active?: boolean;
        isCompacting?: boolean;
        model?: { provider: string; id: string; name?: string } | null;
        sessionName?: string | null;
        ts?: number;
        /** Old (fat) CLI heartbeats may carry mcpStartupReport inline. */
        mcpStartupReport?: Record<string, unknown> | null;
        /** Liveness-only marker emitted by the viewer namespace for backwards compatibility. */
        _livenessOnly?: boolean;
      };

      const nextAgentActive = hb.active === true;
      const nextIsCompacting = hb.isCompacting === true;
      const livenessOnly = hb._livenessOnly === true;
      const cachePatch: Partial<SessionUiCacheEntry> = {
        agentActive: nextAgentActive,
        isCompacting: nextIsCompacting,
      };

      setAgentActive(nextAgentActive);
      setIsCompacting(nextIsCompacting);

      const hbSessionId = lifecycleRefs.activeSessionId.current;
      if (hbSessionId) {
        setSessionsCompacting((prev) => withSetMember(prev, hbSessionId, nextIsCompacting));
      }

      if (nextIsCompacting) {
        setLifecycleStatus("Compacting…");
      } else {
        setLifecycleStatus((prev) => (prev === "Compacting…" ? "Connected" : prev));
      }

      if (typeof hb.ts === "number") {
        setLastHeartbeatAt(hb.ts);
        cachePatch.lastHeartbeatAt = hb.ts;
      }

      // Sync the pending follow-up queue from the runner (authoritative).
      // Skip liveness-only heartbeats — those replay the runner's last stored
      // heartbeat on viewer switch and may carry stale queue state.
      const hbQueue = (evt as { queuedMessages?: unknown }).queuedMessages;
      if (!livenessOnly && Array.isArray(hbQueue)) {
        applyQueuedMessagesSync(hbQueue.filter((m): m is string => typeof m === "string"));
      }

      if (!livenessOnly && !metaSourceHubRef.current) {
        if (Object.prototype.hasOwnProperty.call(hb, "sessionName")) {
          const nextName = normalizeSessionName(hb.sessionName);
          setSessionName(nextName);
          cachePatch.sessionName = nextName;
        }

        if (hb.model) {
          const m = normalizeModel(hb.model);
          if (m) {
            setActiveModel(m);
            cachePatch.activeModel = m;
          }
        }
      }

      if (hb.mcpStartupReport && typeof hb.mcpStartupReport === "object") {
        applyMcpReport(hb.mcpStartupReport);
      }

      patchSessionCache(cachePatch);
      return;
    }

    if (type === "todo_update") {
      const todos = Array.isArray(evt.todos) ? (evt.todos as TodoItem[]) : [];
      setTodoList(todos);
      patchSessionCache({ todoList: todos });
      return;
    }

    if (type === "capabilities") {
      const modelsRaw = Array.isArray(evt.models) ? (evt.models as unknown[]) : [];
      const commandsRaw = Array.isArray(evt.commands) ? (evt.commands as unknown[]) : [];

      const normalizedModels = normalizeModelList(modelsRaw);
      const normalizedCommands = normalizeCommandList(commandsRaw);

      // Keep model state in sync with capability snapshots too.
      setAvailableModels(normalizedModels);
      setAvailableCommands(normalizedCommands);
      patchSessionCache({ availableModels: normalizedModels, availableCommands: normalizedCommands });
      return;
    }

    if (type === "session_metadata_update") {
      // Lightweight metadata-only heartbeat — messages haven't changed.
      // These updates are delivered live on the viewer channel, so apply the
      // full patch directly rather than treating hub meta as authoritative.
      const meta = (evt.metadata ?? {}) as Record<string, unknown>;
      const derived = deriveSessionMetadataUpdatePatch({
        metadata: meta,
        currentActiveModel: activeModelRef.current,
      });
      const cachePatch: Partial<SessionUiCacheEntry> = {};

      if (Object.prototype.hasOwnProperty.call(derived, "activeModel")) {
        setActiveModel(derived.activeModel ?? null);
        cachePatch.activeModel = derived.activeModel ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(derived, "availableModels")) {
        setAvailableModels(derived.availableModels ?? []);
        cachePatch.availableModels = derived.availableModels ?? [];
      }

      if (Object.prototype.hasOwnProperty.call(derived, "availableCommands")) {
        setAvailableCommands(derived.availableCommands ?? []);
        cachePatch.availableCommands = derived.availableCommands ?? [];
      }

      if (Object.prototype.hasOwnProperty.call(derived, "sessionName")) {
        setSessionName(derived.sessionName ?? null);
        cachePatch.sessionName = derived.sessionName ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(derived, "thinkingLevel")) {
        setEffortLevel(derived.thinkingLevel ?? null);
        cachePatch.effortLevel = derived.thinkingLevel ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(derived, "todoList")) {
        const todos = derived.todoList ?? [];
        setTodoList(todos);
        cachePatch.todoList = todos;
      }

      if (Object.prototype.hasOwnProperty.call(derived, "goal")) {
        const nextGoal = derived.goal ?? null;
        setGoal(nextGoal);
        cachePatch.goal = nextGoal;
      }

      if (Object.prototype.hasOwnProperty.call(derived, "queuedMessages")) {
        applyQueuedMessagesSync(derived.queuedMessages ?? []);
      }

      if (Object.prototype.hasOwnProperty.call(meta, "analysis")) {
        const nextAnalysis = meta.analysis as SessionUiCacheEntry["analysis"];
        setAnalysis(nextAnalysis ?? null);
        cachePatch.analysis = nextAnalysis ?? null;
      }

      if (Object.keys(cachePatch).length > 0) {
        patchSessionCache(cachePatch);
      }
      return;
    }

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      const isChunked = !!state?.chunked;
      const resolved = resolveSnapshotMessages(state, requestedSnapshotMessagesRef.current);
      if (!resolved) {
        // An evicted/mismatched checkpoint cannot be hydrated from omitted messages.
        // Retry without a hash; never turn a cache miss into an empty transcript.
        viewerWsRef.current?.emit("switch_session", {
          sessionId: lifecycleRefs.activeSessionId.current!, generation: lifecycleRefs.generation.current,
        });
        return;
      }
      const snapshotId = typeof state?.snapshotId === "string" ? state.snapshotId : "";
      const totalMessages = typeof state?.totalMessages === "number" ? state.totalMessages : rawMessages.length;
      // A newer snapshot supersedes both the old chunks and any deltas buffered
      // against them. Those deltas are already represented in this snapshot.
      deferredChunkEventsRef.current = [];
      onSnapshotStarted({ chunked: isChunked, snapshotId, totalMessages });
      if (isChunked) {
        // The header is real progress: preparing a big snapshot can consume
        // most of the stall window, and the watchdog stays armed through the
        // whole chunked transfer now — without this reset it could restart a
        // healthy transfer right after a slow header, before chunk 0 arrives.
        hydrationRequestedAtRef.current = Date.now();
      }

      const stateModel = normalizeModel(state?.model);
      const stateModels = Array.isArray(state?.availableModels)
        ? normalizeModelList(state.availableModels as unknown[])
        : [];
      const normalizedMessages = resolved.messages;
      if (!isChunked) patchSessionCache({ snapshotMessages: resolved.snapshot });
      const hasSessionName = !!state && Object.prototype.hasOwnProperty.call(state, "sessionName");
      const nextSessionName = hasSessionName ? normalizeSessionName(state?.sessionName) : null;
      const metaViaHub = metaSourceHubRef.current || evt._metaViaHub === true;
      if (evt._metaViaHub === true) {
        metaSourceHubRef.current = true;
      }

      // Flush any queued streaming-delta RAF before replacing state so stale
      // partials can't be re-inserted on top of the fresh snapshot. Chunked
      // snapshots remain off-screen until complete, preserving the last good
      // transcript instead of flashing an empty conversation on every refresh.
      cancelPendingDeltas();
      if (!isChunked) {
        const injected = injectedMessagesRef.current;
        setMessages(injected.length > 0 ? [...normalizedMessages, ...injected] : normalizedMessages);
        const serverHasMore = state?.hasMore === true;
        const oldestLoadedIndex = typeof state?.oldestLoadedIndex === "number" ? state.oldestLoadedIndex : 0;
        paginationStateRef.current = { totalMessages, hasMore: serverHasMore, oldestLoadedIndex };
      }
      if (!metaViaHub) {
        setActiveModel(stateModel);
        if (hasSessionName) {
          setSessionName(nextSessionName);
        }
      }
      setAvailableModels(stateModels);

      // Extract commands from session_active state so cache-first hydration
      // (which only replays snapshot events) populates the command picker.
      const hasStateCommands = !!state && Object.prototype.hasOwnProperty.call(state, "availableCommands");
      const stateCommands = Array.isArray(state?.availableCommands)
        ? normalizeCommandList(state.availableCommands as unknown[])
        : [];
      if (hasStateCommands) {
        setAvailableCommands(stateCommands);
      }

      const hasStateAnalysis = !!state && Object.prototype.hasOwnProperty.call(state, "analysis");
      const stateAnalysis = hasStateAnalysis
        ? state.analysis as SessionUiCacheEntry["analysis"]
        : null;
      if (hasStateAnalysis) {
        setAnalysis(stateAnalysis ?? null);
      }

      const hasStateGoal = !!state && Object.prototype.hasOwnProperty.call(state, "goal");
      const stateGoal = hasStateGoal ? (state.goal as MetaGoalStatus | null) : null;
      if (hasStateGoal) {
        setGoal(stateGoal ?? null);
      }

      // Track chunked delivery state — messages arrive as subsequent
      // session_messages_chunk events when the session is large. Lifecycle
      // state (chunked / lastCompletedSnapshot / hydrated) is owned by
      // useSessionLifecycle via onSnapshotStarted / onSnapshotComplete.

      // Don't clobber transient statuses with a generic "Connected" when the
      // CLI sends a session_active snapshot right after a command.
      // (Non-chunked completion is handled by onSnapshotComplete.)

      // Don't unconditionally clear pendingQuestion / pendingPlan here.
      // session_active is also emitted for non-session-switch actions (model
      // changes, thinking-level updates) and buildSessionState() doesn't carry
      // these transient states.  The heartbeat already manages them; clearing
      // here would cause the action buttons to disappear until the next HB.
      // pendingQuestion and pendingPlan are cleared on session_switch / new_session
      // through the heartbeat (which sets them to null when the runner has none).
      setPluginTrustPrompt(null);
      // Restore in-flight tool calls from the snapshot so reconnecting mid-command
      // keeps streaming indicators and Kill buttons visible. The snapshot payload
      // doesn't include explicit active-tool IDs, so we infer them by scanning
      // for toolCall blocks that have no matching toolResult.
      if (!isChunked) {
        setActiveToolCalls(detectInFlightTools(normalizedMessages));
      } else {
        // Clear stale tool call state from before the reconnect so old
        // streaming badges and Kill buttons don't linger while chunks load.
        setActiveToolCalls(new Map());
      }
      setIsChangingModel(false);
      // For non-chunked sessions, flush any pending MCP report immediately
      if (!isChunked && pendingMcpReportRef.current) {
        applyMcpReport(pendingMcpReportRef.current);
        pendingMcpReportRef.current = null;
      }

      // Sync queued follow-ups from the snapshot — the runner reports its
      // pending queue so messages queued before a session switch survive.
      // Old runners don't send the field: clear, as before (consumed
      // follow-ups are part of the conversation snapshot).
      if (Array.isArray(state?.queuedMessages)) {
        applyQueuedMessagesSync((state.queuedMessages as unknown[]).filter((m): m is string => typeof m === "string"));
      } else {
        setMessageQueue([]);
        patchSessionCache({ messageQueue: [] });
      }

      if (!metaViaHub) {
        // Extract thinkingLevel from session snapshot too
        const thinkingLevel = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
        setEffortLevel(thinkingLevel);

        // Extract todoList from session snapshot
        const stateTodos = Array.isArray(state?.todoList) ? (state.todoList as TodoItem[]) : [];
        setTodoList(stateTodos);

        patchSessionCache({
          ...(!isChunked ? { messages: normalizedMessages } : {}),
          activeModel: stateModel,
          ...(hasSessionName ? { sessionName: nextSessionName } : {}),
          availableModels: stateModels,
          ...(hasStateCommands ? { availableCommands: stateCommands } : {}),
          effortLevel: thinkingLevel,
          todoList: stateTodos,
          ...(hasStateAnalysis ? { analysis: stateAnalysis ?? null } : {}),
          ...(hasStateGoal ? { goal: stateGoal ?? null } : {}),
        });
      } else {
        patchSessionCache({
          ...(!isChunked ? { messages: normalizedMessages } : {}),
          availableModels: stateModels,
          ...(hasStateCommands ? { availableCommands: stateCommands } : {}),
          ...(hasStateAnalysis ? { analysis: stateAnalysis ?? null } : {}),
          ...(hasStateGoal ? { goal: stateGoal ?? null } : {}),
        });
      }
      if (!isChunked) {
        onSnapshotComplete();
      }
      return;
    }

    // ── Chunked message delivery ───────────────────────────────────────────
    // Large sessions send messages as a series of chunks after the metadata-only
    // session_active event. Each chunk appends to the current messages array.
    if (type === "session_messages_chunk") {
      // Ignore chunks that arrive before the matching session_active header.
      // This can happen when a viewer joins mid-stream: the room broadcast
      // delivers in-flight chunks before the viewer's initial snapshot replay.
      // Without this guard, chunks are appended to stale/empty state and then
      // the later metadata-only session_active clears them with setMessages([]).
      if (lifecycleRefs.awaitingSnapshot.current && !lifecycleRefs.chunked.current) {
        return;
      }

      const chunkSnapshotId = typeof evt.snapshotId === "string" ? evt.snapshotId : "";
      const chunkIndex = typeof evt.chunkIndex === "number" ? evt.chunkIndex : -1;
      const chunkMessages = Array.isArray(evt.messages) ? evt.messages as unknown[] : [];
      const isFinal = !!evt.final;
      const totalChunks = typeof evt.totalChunks === "number" ? evt.totalChunks : 0;
      const totalMessages = typeof evt.totalMessages === "number" ? evt.totalMessages : 0;

      // Discard chunks from a stale snapshot stream.  Two cases:
      // 1) A newer snapshot is actively loading (ref is non-null, IDs differ).
      // 2) A snapshot already completed (ref is null) but late chunks from
      //    the superseded sender are still draining — reject if the ID
      //    doesn't match the last completed snapshot.
      if (chunkSnapshotId) {
        if (lifecycleRefs.chunked.current && lifecycleRefs.chunked.current.snapshotId !== chunkSnapshotId) {
          return; // stale chunk — a newer snapshot is loading
        }
        if (!lifecycleRefs.chunked.current && lifecycleRefs.lastCompletedSnapshot.current && lifecycleRefs.lastCompletedSnapshot.current !== chunkSnapshotId) {
          return; // stale chunk — arrived after a newer snapshot completed
        }
      }

      const chunkState = lifecycleRefs.chunked.current;
      if (!chunkState || chunkIndex < 0) {
        return;
      }

      if (isFinal) {
        chunkState.finalChunkSeen = true;
      }

      // Idempotency: duplicate retransmits for the same chunkIndex are ignored.
      if (!registerChunkIndex(chunkState.receivedChunkIndexes, chunkIndex)) {
        return;
      }

      if (Number.isInteger(totalChunks) && totalChunks > 0) {
        chunkState.totalChunks = totalChunks;
      }

      // Buffer this chunk's raw messages by chunkIndex so we can assemble
      // in index order at finalization time. Out-of-order delivery means we
      // must NOT use arrival order — chunk 2 arriving before chunk 1 would
      // produce a scrambled transcript if we append immediately.
      chunkState.chunkBuffer.set(chunkIndex, chunkMessages);

      // Update progress counter for status display.
      chunkState.loadedMessages += chunkMessages.length;
      const loaded = chunkState.loadedMessages;
      onChunkProgress(loaded, totalMessages);
      // The chunk header cleared awaitingSnapshot, but the stall watchdog stays
      // armed while the transfer is in flight (chunked && !hydrated). Treat an
      // arriving chunk as progress so the watchdog does not restart hydration
      // underneath a transfer that is succeeding — a big session over a slow
      // link legitimately exceeds the stall threshold between retries.
      hydrationRequestedAtRef.current = Date.now();

      const readyToFinalize = canFinalizeChunkHydration(
        chunkState.finalChunkSeen,
        chunkState.receivedChunkIndexes,
        chunkState.totalChunks,
      );

      if (shouldRequestChunkRecovery(isFinal, readyToFinalize)) {
        // The relay finalizes its durable snapshot before broadcasting the
        // final chunk. A resync now can therefore recover the complete state
        // without replaying the stale pre-chunk checkpoint.
        // Omit lastSeq: delta-only replay cannot repair a missing historical
        // chunk and would leave hydration stuck if newer deltas are cached.
        viewerWsRef.current?.emit("resync", {});
      }

      if (readyToFinalize) {
        // Assemble all buffered chunks in chunkIndex order so the resulting
        // transcript matches the original server-side ordering regardless of
        // network delivery order.
        const sortedIndexes = Array.from(chunkState.chunkBuffer.keys()).sort((a, b) => a - b);
        const orderedRaw: unknown[] = [];
        for (const idx of sortedIndexes) {
          const buf = chunkState.chunkBuffer.get(idx);
          if (buf) {
            for (const m of buf) orderedRaw.push(m);
          }
        }
        // Convert the ordered raw messages with stable sequential keys and
        // deduplicate the complete assembled list in one pass.
        const convertedOrdered = orderedRaw
          .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
          .filter((m): m is RelayMessage => m !== null);
        const finalMessages = deduplicateMessages(convertedOrdered);

        const injected = injectedMessagesRef.current;
        const completedMessages = injected.length > 0 ? [...finalMessages, ...injected] : finalMessages;
        const deferredEvents = deferredChunkEventsRef.current;
        deferredChunkEventsRef.current = [];

        setMessages(completedMessages);
        setActiveToolCalls(detectInFlightTools(finalMessages));
        paginationStateRef.current = { totalMessages, hasMore: false, oldestLoadedIndex: 0 };
        patchSessionCache({ messages: completedMessages });
        onSnapshotComplete();

        // Queue updates above are applied in order, so replayed functional
        // message updates land on the completed snapshot rather than the old
        // visible transcript.
        for (const deferredEvent of deferredEvents) {
          handleRelayEvent(deferredEvent);
        }

        if (pendingMcpReportRef.current) {
          applyMcpReport(pendingMcpReportRef.current);
          pendingMcpReportRef.current = null;
        }
      }
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      const normalized = normalizeMessages(evt.messages as unknown[]);
      cancelPendingDeltas();
      const injected = injectedMessagesRef.current;
      const withInjected = injected.length > 0 ? [...normalized, ...injected] : normalized;
      setMessages(withInjected);
      patchSessionCache({ messages: withInjected });
      setPendingQuestion(null);
      setPendingPlan(null);
      setPendingApproval(null);
      setArtifactViewer(null);
      setRetryState(null);
      setActiveToolCalls(new Map());
      // Clear message queue — the agent processed any queued steer/followUp
      // messages. If any survived (e.g. abort), the next heartbeat re-syncs.
      setMessageQueue([]);
      patchSessionCache({ messageQueue: [] });
      onSnapshotComplete();
      return;
    }

    if (type === "session_started") {
      // Runner emits { type: "session_started", model: { provider, modelId } }
      // Map modelId → id so normalizeModel can pick it up.
      const raw = evt.model as Record<string, unknown> | undefined;
      if (raw && typeof raw.modelId === "string") {
        const normalized = normalizeModel({ ...raw, id: raw.modelId });
        if (normalized) {
          setActiveModel(normalized);
          patchSessionCache({ activeModel: normalized });
        }
      }
      return;
    }

    if (type === "exec_result") {
      const ok = evt.ok === true;
      const command = typeof evt.command === "string" ? String(evt.command) : "";
      // result is the dynamic exec response payload — typed as Record for property access
      const result = evt.result as Record<string, unknown> | null | undefined;
      if (!ok) {
        const error = typeof evt.error === "string" ? evt.error : "Command failed";
        if (command === "list_resume_sessions") {
          setResumeSessionsLoading(false);
        }
        if (command === "get_fork_messages") {
          setForkMessagesLoading(false);
        }
        if (command === "fork") {
          // A failed rewind leaves the transcript untouched — surface the error
          // in the transcript itself, not just the easily-missed status line
          // (e.g. "fork is not available in this pi version" from a runner
          // that predates the rewind feature and needs a restart).
          appendLocalSystemMessage(`**/rewind** failed: ${error}`);
        }
        if (command === "refresh_usage") {
          setUsageRefreshing(false);
        }
        if (command === "compact") {
          // Don't force isCompacting=false here — let the heartbeat remain
          // the source of truth. The error may be "already in progress"
          // (compaction is still running), and unconditionally clearing the
          // flag would re-enable input prematurely until the next heartbeat.
        }
        setLifecycleStatus(`/${command}: ${error}`);
        return;
      }

      if (command === "background_bash") {
        const list = Array.isArray(result?.backgrounded) ? (result.backgrounded as string[]) : [];
        setLifecycleStatus(`Backgrounded: ${list.join(", ")}`);
        return;
      }

      if (command === "refresh_usage") {
        const nextUsage = result?.providerUsage && typeof result.providerUsage === "object"
          ? (result.providerUsage as ProviderUsageMap)
          : null;
        setUsageRefreshing(false);
        if (nextUsage) {
          setProviderUsage(nextUsage);
          patchSessionCache({ providerUsage: nextUsage });
        }
        setLifecycleStatus("Usage refreshed");
        return;
      }

      if (command === "list_resume_sessions") {
        if (resumeSessionsFallbackTimerRef.current) {
          clearTimeout(resumeSessionsFallbackTimerRef.current);
          resumeSessionsFallbackTimerRef.current = null;
        }
        const normalized = parseResumeSessionList(result);

        const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
        const isAppend = resumeSessionsAppendRef.current;
        resumeSessionsAppendRef.current = false;

        if (isAppend) {
          // Append to existing list, deduplicating by id
          setResumeSessions((prev) => appendUniqueResumeSessions(prev, normalized));
        } else {
          setResumeSessions(normalized);
        }
        setResumeSessionsNextCursor(nextCursor);
        setResumeSessionsLoading(false);
        if (!isAppend && normalized.length === 0) {
          setLifecycleStatus("No resumable sessions");
        }
        return;
      }

      if (command === "get_fork_messages") {
        const normalized = parseForkMessageList(result);
        setForkMessages(normalized);
        setForkMessagesLoading(false);
        if (normalized.length === 0) {
          setLifecycleStatus("No messages to rewind to");
        }
        return;
      }

      if (command === "fork") {
        // The runner emits a fresh session_active with the rewound transcript;
        // stale fork candidates from the pre-fork session are cleared here.
        setForkMessages([]);
        setLifecycleStatus("Conversation rewound");
        return;
      }

      if (command === "get_last_assistant_text") {
        const text = typeof result?.text === "string" ? result.text : "";
        if (text) {
          void navigator.clipboard.writeText(text);
          setLifecycleStatus("Copied");
        } else {
          setLifecycleStatus("Nothing to copy");
        }
        return;
      }

      if (command === "mcp") {
        // Build structured command result for rich card rendering
        const mcpResult = buildMcpCommandResult(result);
        appendLocalSystemMessage(mcpResult);

        const summary = typeof result?.summary === "string"
          ? result.summary
          : `MCP tools loaded: ${mcpResult.toolCount}`;
        setLifecycleStatus(summary);
        return;
      }

      if (command === "mcp_toggle_server") {
        // Build the same structured card as /mcp status, showing updated state
        const toggleResult = buildMcpCommandResult(result, "reload");
        const toggledServer = typeof result?.toggledServer === "string" ? result.toggledServer : "";
        const disabled = result?.disabled === true;

        appendLocalSystemMessage(toggleResult);

        const verb = disabled ? "Disabled" : "Enabled";
        setLifecycleStatus(`${verb} MCP server "${toggledServer}". ${toggleResult.toolCount} tools loaded.`);
        return;
      }

      if (command === "cycle_thinking_level" || command === "set_thinking_level") {
        const newLevel = typeof result?.thinkingLevel === "string" ? result.thinkingLevel : null;
        setEffortLevel(newLevel);
        patchSessionCache({ effortLevel: newLevel });
        setLifecycleStatus(newLevel && newLevel !== "off" ? `Effort: ${newLevel}` : "Effort: off");
        return;
      }

      if (command === "set_plan_mode") {
        const enabled = !!result?.planModeEnabled;
        setPlanModeEnabled(enabled);
        patchSessionCache({ planModeEnabled: enabled });
        setLifecycleStatus(enabled ? "⏸ Plan mode ON" : "▶ Plan mode OFF");
        return;
      }

      if (command === "set_session_name") {
        const nextSessionName = normalizeSessionName(result?.sessionName);
        setSessionName(nextSessionName);
        patchSessionCache({ sessionName: nextSessionName });
        setLifecycleStatus(nextSessionName ? "Session renamed" : "Session name cleared");
        return;
      }

      if (command === "set_model" || command === "cycle_model") {
        setLifecycleStatus("Model set");
        // Runner should also emit session_active/model_select, but in case it doesn't,
        // opportunistically refresh capabilities by asking for commands again (cheap).
        return;
      }

      if (command === "compact") {
        setIsCompacting(false);
        const compactDoneId = lifecycleRefs.activeSessionId.current;
        if (compactDoneId) {
          setSessionsCompacting((prev) => withSetMember(prev, compactDoneId, false));
        }
        const summary = formatCompactSummary(result);
        setLifecycleStatus(summary);
        // Clear the compact status after a few seconds so it doesn't stick forever
        setTimeout(() => setLifecycleStatus((prev) => (prev === summary || prev.startsWith("Compacted") ? "Connected" : prev)), 5000);
        return;
      }

      if (command === "new_session") {
        cancelPendingDeltas();
        injectedMessagesRef.current = [];
        setMessages([]);
        setPendingQuestion(null);
        setPendingPlan(null);
        setMcpOAuthPastes([]);
        setActiveToolCalls(new Map());
        setMessageQueue([]);
        setSessionName(null);
        setAgentActive(false);
        patchSessionCache({
          messages: [],
          sessionName: null,
          agentActive: false,
          messageQueue: [],
        });
        // Clear trigger history so the Triggers panel starts fresh
        const sid = lifecycleRefs.activeSessionId.current;
        if (sid) {
          void fetch(`/api/sessions/${encodeURIComponent(sid)}/triggers`, {
            method: "DELETE",
            credentials: "include",
          }).then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          }).catch((err) => console.error("Failed to clear trigger history:", err));
        }
        setLifecycleStatus("New session started");
        return;
      }

      if (command === "restart") {
        // Remember which session is restarting so we can auto-reconnect when it
        // comes back live.  The session ID is stable across a restart (PIZZAPI_SESSION_ID).
        const pendingId = lifecycleRefs.activeSessionId.current;
        if (pendingId) {
          onViewerDisconnected({ reason: "Session reconnected", isRestarting: true });
        }
        return;
      }

      if (command === "end_session") {
        setLifecycleStatus("Ending session…");
        return;
      }

      if (command === "resume_session") {
        setLifecycleStatus("Session resumed");
        return;
      }

      setLifecycleStatus("OK");
      return;
    }

    if (type === "mcp_startup_report") {
      const report = evt as {
        slow?: boolean;
        showSlowWarning?: boolean;
        errors?: Array<{ server: string; error: string }>;
        serverTimings?: Array<{
          name: string;
          durationMs: number;
          toolCount: number;
          timedOut: boolean;
          error?: string;
        }>;
        totalDurationMs?: number;
        ts?: number;
      };
      applyMcpReport(report);
      return;
    }

    if (type === "mcp_auth_required") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const authUrl = typeof evt.authUrl === "string" ? evt.authUrl : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();

      // Only render clickable link for safe http/https URLs to prevent XSS
      const isSafeUrl = (() => {
        try { const p = new URL(authUrl ?? ""); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
      })();
      if (authUrl && isSafeUrl) {
        const stableKey = `mcp_auth:${serverName}`;
        const message: RelayMessage = {
          key: stableKey,
          role: "system",
          timestamp: ts,
          content: `🔐 **${serverName}** requires authentication.\n\n[Click here to authenticate](${authUrl})`,
          isError: false,
        };
        // Store in ref so it survives wholesale setMessages replacements.
        // Upsert: replace existing message for this server (URL/state may
        // have changed on retry), or append if first time.
        const nextInjected = replaceMessageByStableKey(injectedMessagesRef.current, stableKey, message);
        injectedMessagesRef.current = nextInjected;
        const nextMessages = replaceMessageByStableKey(messagesRef.current, stableKey, message);
        setMessages(nextMessages);
        patchSessionCache({ messages: nextMessages });
      }
      return;
    }

    if (type === "mcp_auth_paste_required") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const authUrl = typeof evt.authUrl === "string" ? evt.authUrl : null;
      const nonce = typeof evt.nonce === "string" ? evt.nonce : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();

      if (authUrl && nonce) {
        // Inject a system message pointing to the paste component.
        // Use a stable key (no timestamp) so re-emitted events replace
        // the existing message instead of accumulating duplicates.
        const stableKey = `mcp_auth:${serverName}`;
        const message: RelayMessage = {
          key: stableKey,
          role: "system",
          timestamp: ts,
          content: `🔐 **${serverName}** requires authentication — use the prompt below to sign in.`,
          isError: false,
        };
        // Upsert: replace existing message (nonce/URL may change on retry)
        const nextInjected = replaceMessageByStableKey(injectedMessagesRef.current, stableKey, message);
        injectedMessagesRef.current = nextInjected;
        const nextMessages = replaceMessageByStableKey(messagesRef.current, stableKey, message);
        setMessages(nextMessages);
        patchSessionCache({ messages: nextMessages });
        // Add/update pending paste prompt (always update nonce/authUrl)
        setMcpOAuthPastes((prev) => [
          ...prev.filter((p) => p.serverName !== serverName),
          { serverName, authUrl, nonce, ts },
        ]);
      }
      return;
    }

    if (type === "mcp_auth_complete") {
      const serverName = typeof evt.serverName === "string" ? evt.serverName : "MCP server";
      const stableKey = `mcp_auth:${serverName}`;
      // Remove the auth banner for this server — auth succeeded
      injectedMessagesRef.current = removeMessagesByStableKey(injectedMessagesRef.current, stableKey);
      // Also remove from rendered messages
      const filteredNext = removeMessagesByStableKey(messagesRef.current, stableKey);
      if (filteredNext.length !== messagesRef.current.length) {
        setMessages(filteredNext);
        patchSessionCache({ messages: filteredNext });
      }
      // Remove from pending paste prompts
      setMcpOAuthPastes((prev) => prev.filter((p) => p.serverName !== serverName));
      return;
    }

    if (type === "cli_error") {
      const message = typeof evt.message === "string" ? evt.message : "An error occurred in the CLI";
      const source = typeof evt.source === "string" && evt.source ? evt.source : null;
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();
      const label = source ? `CLI Error (${source})` : "CLI Error";
      const errMessage: RelayMessage = {
        key: `cli_error:${ts}:${Math.random().toString(16).slice(2)}`,
        role: "system",
        timestamp: ts,
        content: `⚠ ${label}: ${message}`,
        isError: true,
      };
      const next = [...messagesRef.current, errMessage];
      setMessages(next);
      patchSessionCache({ messages: next });
      return;
    }

    if (type === "model_select") {
      const selected = normalizeModel(evt.model);
      if (selected) {
        setActiveModel(selected);
        patchSessionCache({ activeModel: selected });
      }
      setIsChangingModel(false);
      return;
    }

    if (type === "model_set_result") {
      const ok = evt.ok === true;
      setIsChangingModel(false);
      if (ok) {
        // Keep wording consistent with "model_select" and make it clear the change succeeded.
        setLifecycleStatus("Model set");
      } else {
        const message = typeof evt.message === "string" ? evt.message : "Failed to set model";
        setLifecycleStatus(message);
      }
      return;
    }

    if (type === "tool_execution_start") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      if (toolCallId) {
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.set(toolCallId, toolName);
          if (prev.size === 0) startToolHaptic();
          return next;
        });
      }
    }

    if (type === "tool_execution_update") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      // AskUserQuestion and plan_mode updates are handled separately below — skip here.
      if (toolCallId && toolName !== "AskUserQuestion" && toolName !== "plan_mode") {
        const partial = evt.partialResult as Record<string, unknown> | undefined;
        const content = partial?.content;
        if (content !== undefined && content !== null) {
          // Buffer the partial as a synthetic toolResult keyed by toolCallId.
          // The RAF-based scheduleToolStreamFlush will upsert it into message
          // state (at most once per frame), so the grouping code merges it with
          // the pending-tool card and the UI renders live output.
          //
          // The shape (content/details as sibling fields, not wrapped) is
          // produced by buildStreamingPartialMessage — see that helper for the
          // rationale and the message-helpers regression tests.
          pendingToolStreamRef.current.set(
            toolCallId,
            buildStreamingPartialMessage({
              toolCallId,
              toolName,
              partialResult: partial,
            }),
          );
          scheduleToolStreamFlush();
        }
      }
    }

    if (type === "tool_execution_end") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      if (toolCallId) {
        // Evict any buffered streaming partial for this tool call so a pending
        // RAF flush can't overwrite the final tool result that arrives shortly
        // via message_update/message_end.
        pendingToolStreamRef.current.delete(toolCallId);
        if (pendingToolStreamRef.current.size === 0 && toolStreamRafRef.current !== null) {
          cancelAnimationFrame(toolStreamRafRef.current);
          toolStreamRafRef.current = null;
        }
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.delete(toolCallId);
          if (next.size === 0) stopToolHaptic();
          return next;
        });
      }
    }

    if (type === "plugin_trust_prompt") {
      const promptId = evt.promptId as string | undefined;
      const names = evt.pluginNames as string[] | undefined;
      const summaries = evt.pluginSummaries as string[] | undefined;
      if (typeof promptId === "string" && Array.isArray(names) && names.length > 0) {
        setPluginTrustPrompt({
          promptId,
          pluginNames: names,
          pluginSummaries: Array.isArray(summaries) ? summaries : names,
        });
      }
      return;
    }

    if (type === "plugin_trust_expired") {
      const promptId = evt.promptId as string | undefined;
      setPluginTrustPrompt((prev) =>
        prev && prev.promptId === promptId ? null : prev
      );
      return;
    }

    if (type === "tool_execution_start" && evt.toolName === "AskUserQuestion") {
      const args = evt.args as Record<string, unknown> | undefined;
      const questions = parsePendingQuestions(args);

      if (questions.length > 0) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : getFallbackPromptKey(questions),
          questions,
          display: parsePendingQuestionDisplayMode(args, questions.length),
        });
        setLifecycleStatus("Waiting for answer…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "AskUserQuestion") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      // Try from partial first, then nested details (parsePendingQuestions returns [] not falsy)
      const fromPartial = parsePendingQuestions(partial);
      const fromDetails = parsePendingQuestions(details);
      const usePartial = fromPartial.length > 0;
      const questions = usePartial ? fromPartial : fromDetails;
      const displaySource = usePartial ? partial : details;

      if (questions.length > 0) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : getFallbackPromptKey(questions),
          questions,
          display: parsePendingQuestionDisplayMode(displaySource, questions.length),
        });
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "AskUserQuestion") {
      setPendingQuestion(null);
      setLifecycleStatus("Connected");
      return;
    }

    // ── plan_mode events ────────────────────────────────────────────────────
    if (type === "tool_execution_start" && evt.toolName === "plan_mode") {
      const args = evt.args as Record<string, unknown> | undefined;
      const plan = parsePlanModeSource(args, evt.toolCallId, () => `plan-${Date.now()}`);
      if (plan) {
        setPendingPlan(plan);
        setLifecycleStatus("Waiting for plan review…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "plan_mode") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      const source = details ?? partial;
      const plan = parsePlanModeSource(source, evt.toolCallId, () => `plan-${Date.now()}`);
      if (plan) {
        setPendingPlan(plan);
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "plan_mode") {
      setPendingPlan(null);
      setLifecycleStatus("Connected");
      return;
    }

    if (type === "agent_end") {
      cancelHaptic();
      setActiveToolCalls(new Map());
    }

    if (type === "message_update") {
      const assistantEvent = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent && assistantEvent.partial) {
        const deltaType = typeof assistantEvent.type === "string" ? assistantEvent.type : "";
        const contentIndex = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : -1;

        // Track wall-clock duration of each thinking block.
        if (deltaType === "thinking_start" && contentIndex >= 0) {
          thinkingStartTimesRef.current.set(contentIndex, Date.now());
        } else if (deltaType === "thinking_end" && contentIndex >= 0) {
          const startTime = thinkingStartTimesRef.current.get(contentIndex);
          if (startTime !== undefined) {
            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
            thinkingDurationsRef.current.set(contentIndex, durationSeconds);
            thinkingStartTimesRef.current.delete(contentIndex);
          }
        }

        const isStreamingDelta =
          deltaType === "toolcall_delta" ||
          deltaType === "text_delta" ||
          deltaType === "thinking_delta";
        const partial = assistantEvent.partial as Record<string, unknown>;
        const raw = augmentThinkingDurations({ ...partial, timestamp: undefined }, thinkingDurationsRef.current);
        if (isStreamingDelta) {
          if (deltaType === "text_delta" || deltaType === "thinking_delta") {
            const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
            pulseStreamingHaptic(delta);
          }
          upsertMessageDebounced(raw, "message-update-partial");
        } else {
          upsertMessage(raw, "message-update-partial");
        }
        return;
      }
      upsertMessage(evt.message, "message-update");
      return;
    }

    if (type === "message_start") {
      upsertMessage(evt.message, type);
      // When a user message appears in the stream, remove the matching queued message
      removeQueuedMessageByContent(evt.message);
    }

    if (type === "message_end" || type === "turn_end") {
      cancelHaptic();
      upsertMessage(augmentThinkingDurations(evt.message, thinkingDurationsRef.current), type, true);
      // When a user message appears in the stream, remove the matching queued message
      removeQueuedMessageByContent(evt.message);
      // Reset for the next assistant message.
      thinkingStartTimesRef.current = new Map();
      thinkingDurationsRef.current = new Map();
    }

    // PATCH(pizzapi): Forward ui_notify events from the runner to the toast system
    // and append as a system message in the chat.
    if (type === "ui_notify") {
      const raw = evt as unknown as { message: string; notifyType?: "info" | "warning" | "error" };
      // Strip ANSI escape codes (terminal color codes) so they don't show
      // as raw gibberish in the web UI.
      // oxlint-disable-next-line no-control-regex -- intentional: matches ANSI escape sequences to strip them
      const clean = raw.message.replace(/\x1b\[[0-9;]*m/g, "");
      const payload = { message: clean, notifyType: raw.notifyType };
      handleUiNotifyRef.current(payload);
      const prefix = payload.notifyType === "error" ? "❌" : payload.notifyType === "warning" ? "⚠️" : "🔔";
      appendLocalSystemMessage(`${prefix} ${clean}`);
    }
  }, [
    upsertMessage,
    upsertMessageDebounced,
    cancelPendingDeltas,
    appendLocalSystemMessage,
    scheduleToolStreamFlush,
    applyMcpReport,
    getFallbackPromptKey,
    patchSessionCache,
    removeQueuedMessageByContent,
    applyQueuedMessagesSync,
    activeModel,
    onSnapshotStarted,
    onSnapshotComplete,
    onChunkProgress,
  ]);

  return handleRelayEvent;
}
