import * as React from "react";
import type { SessionMetaState } from "@pizzapi/protocol";
import type { RelayMessage } from "@/components/SessionViewer";
import type { CommandResultData } from "@/components/session-viewer/rendering";
import type { ProviderUsageMap } from "@/components/UsageIndicator";
import { parsePendingQuestionDisplayMode, parsePendingQuestions } from "@/lib/ask-user-questions";
import type { TodoItem, TokenUsage, QueuedMessage, SessionUiCacheEntry } from "@/lib/types";
import type { MetaStatePatch } from "@/lib/meta-state-apply";
import { normalizeModel } from "@/lib/message-helpers";
import { reconcileMessageQueue } from "@/lib/message-queue";
import type { SessionLifecycleRefs } from "@/lib/use-session-lifecycle";
import type { SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { StateSetter } from "./types";
import { formatMcpStartupReport, type McpStartupReport } from "./mcp-startup-report";
import { normalizeMetaPendingPlan } from "./pending-plan";
import { extractTextContent } from "./relay-message-merge";
import { withSetMember } from "./session-cache-entry";

export interface SessionMetaAppliersOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycleRefs: SessionLifecycleRefs;
  setLifecycleStatus: (status: React.SetStateAction<string>) => void;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  setTodoList: StateSetter<TodoItem[]>;
  setPlanModeEnabled: StateSetter<boolean>;
  setIsCompacting: StateSetter<boolean>;
  setSessionsCompacting: StateSetter<Set<string>>;
}

/**
 * Callbacks that fold incoming session state into the viewer: hub meta
 * snapshots/patches, MCP startup reports, local system messages and the
 * runner-authoritative follow-up queue. Each writes both React state and the
 * per-session UI cache.
 */
export function useSessionMetaAppliers(options: SessionMetaAppliersOptions) {
  const {
    session: {
      messagesRef,
      setMessages, setMessageQueue, setPendingQuestion, setPendingPlan, setRetryState,
      setPluginTrustPrompt, setPendingApproval, setTokenUsage, setProviderUsage,
      setEffortLevel, setAuthSource, setActiveModel, setGoal,
    },
    refs: { renderedMcpReportTsRef, pendingMcpReportRef, queueSyncSuppressUntilRef },
    lifecycleRefs,
    setLifecycleStatus,
    patchSessionCache,
    setTodoList,
    setPlanModeEnabled,
    setIsCompacting,
    setSessionsCompacting,
  } = options;

  // Cached fallback promptKey for when toolCallId is absent (legacy/compat).
  // Only changes when the question content changes, preventing heartbeat
  // re-applications from resetting the MC component's selection state.
  // Stable fallback promptKey: only changes when question content changes.
  const pendingQuestionFallbackRef = React.useRef<{ fingerprint: string; key: string }>({ fingerprint: "", key: "" });
  const pendingQuestionSeqRef = React.useRef(0);
  /** Return a stable fallback key for a set of parsed questions (used when toolCallId is absent). */
  const getFallbackPromptKey = React.useCallback((questions: Array<{ question: string; options: string[] }>): string => {
    const fp = JSON.stringify(questions);
    if (pendingQuestionFallbackRef.current.fingerprint !== fp) {
      pendingQuestionFallbackRef.current = {
        fingerprint: fp,
        key: `ask-user-question-${++pendingQuestionSeqRef.current}`,
      };
    }
    return pendingQuestionFallbackRef.current.key;
  }, []);

  const appendLocalSystemMessage = React.useCallback((content: string | CommandResultData) => {
    if (content === undefined || content === null) return;
    // For plain strings, trim and skip empties
    if (typeof content === "string" && !content.trim()) return;

    const now = Date.now();
    const message: RelayMessage = {
      key: `system:local:${now}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: now,
      content: typeof content === "string" ? content.trim() : content,
    };

    const next = [...messagesRef.current, message];
    setMessages(next);
    patchSessionCache({ messages: next });
  }, [patchSessionCache]);

  /** Remove a queued message whose text matches an incoming user message from the stream. */
  const removeQueuedMessageByContent = React.useCallback((rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== "object") return;
    const msg = rawMessage as Record<string, unknown>;
    if (msg.role !== "user") return;

    // Extract text from user message content (string or array of text blocks)
    const text = extractTextContent(msg.content);
    if (!text) return;

    const trimmed = text.trim();
    let nextQueue: QueuedMessage[] | null = null;
    setMessageQueue((prev) => {
      if (prev.length === 0) return prev;
      // Find the first queued message whose text matches and remove it
      const idx = prev.findIndex((qm) => qm.text.trim() === trimmed);
      if (idx === -1) return prev;
      nextQueue = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      return nextQueue;
    });
    if (nextQueue) patchSessionCache({ messageQueue: nextQueue });
  }, [patchSessionCache]);

  /** Apply the authoritative pending follow-up queue reported by the runner. */
  const applyQueuedMessagesSync = React.useCallback((texts: string[]) => {
    if (Date.now() < queueSyncSuppressUntilRef.current) return;
    let changed = false;
    let nextQueue: QueuedMessage[] = [];
    setMessageQueue((prev) => {
      nextQueue = reconcileMessageQueue(prev, texts);
      changed = nextQueue !== prev;
      return nextQueue;
    });
    if (changed) patchSessionCache({ messageQueue: nextQueue });
  }, [patchSessionCache]);

  const applyMcpReport = React.useCallback((mcpReport: McpStartupReport) => {
    const reportTs = typeof mcpReport.ts === "number" ? mcpReport.ts : 0;
    if (reportTs <= 0 || reportTs === renderedMcpReportTsRef.current || !lifecycleRefs.hydrated.current) return;
    const formatted = formatMcpStartupReport(mcpReport);
    if (!formatted) return;
    renderedMcpReportTsRef.current = reportTs;
    const message: RelayMessage = {
      key: `mcp_startup:${reportTs}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: reportTs,
      content: formatted.content,
      isError: formatted.isError,
    };
    // Use a functional updater so this chains correctly with any preceding
    // setMessages(prev => ...) call in the same React batch (e.g. the final
    // snapshot chunk updater).  Reading messagesRef.current here would be
    // stale because the ref is only synced after the React commit.
    let mcpNext: RelayMessage[] | null = null;
    setMessages((prev) => {
      if (prev.some((m) => m.key?.startsWith(`mcp_startup:${reportTs}`))) {
        return prev; // already appended — no change
      }
      mcpNext = [...prev, message];
      return mcpNext;
    });
    if (mcpNext !== null) {
      patchSessionCache({ messages: mcpNext });
    }
  }, [patchSessionCache]);

  const applyMetaStateSnapshot = React.useCallback((state: SessionMetaState) => {
    const cachePatch: Partial<SessionUiCacheEntry> = {};

    if (Array.isArray(state.todoList)) {
      setTodoList(state.todoList as TodoItem[]);
      cachePatch.todoList = state.todoList as TodoItem[];
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingQuestion")) {
      const pq = state.pendingQuestion;
      if (pq) {
        const questions = parsePendingQuestions(pq as unknown as Record<string, unknown>);
        if (questions.length > 0) {
          const resolved = {
            toolCallId: typeof pq.toolCallId === "string" ? pq.toolCallId : getFallbackPromptKey(questions),
            questions,
            display: parsePendingQuestionDisplayMode(pq as unknown as Record<string, unknown>, questions.length),
          };
          setPendingQuestion(resolved);
          cachePatch.pendingQuestion = resolved;
          setLifecycleStatus("Waiting for answer…");
        } else {
          setPendingQuestion(null);
          cachePatch.pendingQuestion = null;
        }
      } else {
        setPendingQuestion(null);
        cachePatch.pendingQuestion = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingPlan")) {
      const resolved = normalizeMetaPendingPlan(state.pendingPlan, true);
      if (resolved) {
        setPendingPlan(resolved);
        cachePatch.pendingPlan = resolved;
        setLifecycleStatus("Waiting for plan review…");
      } else {
        setPendingPlan(null);
        cachePatch.pendingPlan = null;
      }
    }

    if (typeof state.planModeEnabled === "boolean") {
      setPlanModeEnabled(state.planModeEnabled);
      cachePatch.planModeEnabled = state.planModeEnabled;
    }

    if (typeof state.isCompacting === "boolean") {
      setIsCompacting(state.isCompacting);
      cachePatch.isCompacting = state.isCompacting;
      if (state.isCompacting) {
        setLifecycleStatus("Compacting…");
      }
      const snapSessionId = lifecycleRefs.activeSessionId.current;
      if (snapSessionId) {
        setSessionsCompacting((prev) => withSetMember(prev, snapSessionId, !!state.isCompacting));
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "retryState")) {
      setRetryState(state.retryState);
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingPluginTrust")) {
      const pt = state.pendingPluginTrust;
      if (pt && typeof pt.promptId === "string" && Array.isArray(pt.pluginNames) && pt.pluginNames.length > 0) {
        setPluginTrustPrompt({
          promptId: pt.promptId,
          pluginNames: pt.pluginNames,
          pluginSummaries: Array.isArray(pt.pluginSummaries) ? pt.pluginSummaries : pt.pluginNames,
        });
      } else {
        setPluginTrustPrompt(null);
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "pendingApproval")) {
      const ap = state.pendingApproval;
      setPendingApproval(ap && typeof ap.promptId === "string" && typeof ap.title === "string" ? ap : null);
    }

    if (Object.prototype.hasOwnProperty.call(state, "tokenUsage")) {
      const usage = state.tokenUsage as TokenUsage | null;
      setTokenUsage(usage);
      cachePatch.tokenUsage = usage;
    }

    if (Object.prototype.hasOwnProperty.call(state, "providerUsage")) {
      const usage = state.providerUsage as ProviderUsageMap | null;
      setProviderUsage(usage);
      cachePatch.providerUsage = usage;
    }

    if (state.thinkingLevel !== undefined) {
      setEffortLevel(state.thinkingLevel);
      cachePatch.effortLevel = state.thinkingLevel;
    }

    if (state.authSource !== undefined) {
      setAuthSource(state.authSource);
      cachePatch.authSource = state.authSource;
    }

    if (state.model !== undefined) {
      if (state.model) {
        const m = normalizeModel(state.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      } else {
        // snapshot explicitly clears model
        setActiveModel(null);
        cachePatch.activeModel = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "goal")) {
      setGoal(state.goal ?? null);
      cachePatch.goal = state.goal ?? null;
    }

    // Apply mcpStartupReport from snapshot so late-joining viewers see MCP startup warnings.
    // If session is not yet hydrated, save it for replay once session_active arrives —
    // the new slim-heartbeat CLI no longer retries in every heartbeat, so without this
    // the report would be permanently lost for any viewer connecting to an existing session.
    if (state.mcpStartupReport) {
      if (lifecycleRefs.hydrated.current) {
        applyMcpReport(state.mcpStartupReport as Record<string, unknown>);
      } else {
        pendingMcpReportRef.current = state.mcpStartupReport as Record<string, unknown>;
      }
    }

    if (Object.keys(cachePatch).length > 0) {
      patchSessionCache(cachePatch);
    }
  }, [applyMcpReport, getFallbackPromptKey, patchSessionCache]);

  const applyMetaPatch = React.useCallback((patch: MetaStatePatch) => {
    const cachePatch: Partial<SessionUiCacheEntry> = {};

    if (patch.todoList !== undefined) {
      setTodoList(patch.todoList);
      cachePatch.todoList = patch.todoList;
    }

    if (patch.setPendingQuestion) {
      if (patch.pendingQuestion) {
        setPendingQuestion(patch.pendingQuestion);
        cachePatch.pendingQuestion = patch.pendingQuestion;
        setLifecycleStatus("Waiting for answer…");
      } else {
        setPendingQuestion(null);
        cachePatch.pendingQuestion = null;
      }
    }

    if (patch.setPendingPlan) {
      if (patch.pendingPlan) {
        const resolved = normalizeMetaPendingPlan(patch.pendingPlan, false);
        if (resolved) {
          setPendingPlan(resolved);
          cachePatch.pendingPlan = resolved;
          setLifecycleStatus("Waiting for plan review…");
        }
      } else {
        setPendingPlan(null);
        cachePatch.pendingPlan = null;
      }
    }

    if (patch.planModeEnabled !== undefined) {
      setPlanModeEnabled(patch.planModeEnabled);
      cachePatch.planModeEnabled = patch.planModeEnabled;
    }

    if (patch.isCompacting !== undefined) {
      setIsCompacting(patch.isCompacting);
      cachePatch.isCompacting = patch.isCompacting;
      const patchSessionId = lifecycleRefs.activeSessionId.current;
      if (patchSessionId) {
        setSessionsCompacting((prev) => withSetMember(prev, patchSessionId, !!patch.isCompacting));
      }
      if (patch.viewerStatusOverride) {
        setLifecycleStatus(patch.viewerStatusOverride);
      } else if (!patch.isCompacting) {
        setLifecycleStatus((prev) => (prev === "Compacting…" ? "Connected" : prev));
      }
    } else if (patch.viewerStatusOverride) {
      setLifecycleStatus(patch.viewerStatusOverride);
    }

    if ("retryState" in patch) {
      setRetryState(patch.retryState ?? null);
    }

    if ("pluginTrustPrompt" in patch) {
      if (patch.pluginTrustPrompt) {
        const pt = patch.pluginTrustPrompt;
        if (pt.promptId && Array.isArray(pt.pluginNames) && pt.pluginNames.length > 0) {
          setPluginTrustPrompt({
            promptId: pt.promptId,
            pluginNames: pt.pluginNames,
            pluginSummaries: Array.isArray(pt.pluginSummaries) ? pt.pluginSummaries : pt.pluginNames,
          });
        }
      } else {
        setPluginTrustPrompt(null);
      }
    }

    if (patch.setPendingApproval) {
      setPendingApproval(patch.pendingApproval ?? null);
    }

    if (patch.tokenUsage !== undefined) {
      setTokenUsage(patch.tokenUsage);
      cachePatch.tokenUsage = patch.tokenUsage;
    }

    if (patch.providerUsage !== undefined) {
      setProviderUsage(patch.providerUsage);
      cachePatch.providerUsage = patch.providerUsage;
    }

    if (patch.thinkingLevel !== undefined) {
      setEffortLevel(patch.thinkingLevel);
      cachePatch.effortLevel = patch.thinkingLevel;
    }

    if (patch.authSource !== undefined) {
      setAuthSource(patch.authSource);
      cachePatch.authSource = patch.authSource;
    }

    if (patch.model !== undefined) {
      if (patch.model) {
        const m = normalizeModel(patch.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      } else {
        // model_changed with null — clear the active model
        setActiveModel(null);
        cachePatch.activeModel = null;
      }
    }

    if (patch.goal !== undefined) {
      setGoal(patch.goal ?? null);
      cachePatch.goal = patch.goal ?? null;
    }

    if (Object.keys(cachePatch).length > 0) {
      patchSessionCache(cachePatch);
    }
  }, [patchSessionCache]);

  return {
    getFallbackPromptKey,
    appendLocalSystemMessage,
    removeQueuedMessageByContent,
    applyQueuedMessagesSync,
    applyMcpReport,
    applyMetaStateSnapshot,
    applyMetaPatch,
  };
}
