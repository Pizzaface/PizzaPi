import * as React from "react";
import { io, type Socket } from "socket.io-client";
import type { ViewerServerToClientEvents, ViewerClientToServerEvents } from "@pizzapi/protocol";
import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import type { HubSession } from "@/components/SessionSidebar";
import type { ConfiguredModelInfo, QueuedMessage, SessionUiCacheEntry } from "@/lib/types";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import { QUEUE_SYNC_SUPPRESS_MS, UI_VERSION } from "./constants";
import type { SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { StateSetter } from "./types";
import { appendUniqueResumeSessions, mapPersistedSessions, type PersistedSessionRow } from "./exec-result-parsers";

export interface RemoteCommandsOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycle: UseSessionLifecycleResult;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  setLiveSessions: StateSetter<HubSession[]>;
  socketUrl: (namespace: string) => string;
  buildSocketAuth: (extra: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Commands the viewer sends to the runner over the viewer socket (`exec`,
 * `model_set`) plus the history / fork / usage / follow-up-queue requests
 * built on top of them.
 */
export function useRemoteCommands(options: RemoteCommandsOptions) {
  const {
    session: {
      sessionState: { pluginTrustPrompt, usageRefreshing, messageQueue },
      setPluginTrustPrompt, setAgentActive, setResumeSessions, setResumeSessionsLoading,
      setResumeSessionsNextCursor, setForkMessagesLoading, setUsageRefreshing,
      setMessageQueue, setIsChangingModel, setModelSelectorOpen,
    },
    refs: {
      viewerWsRef, historyIsServerSourcedRef, resumeSessionsAppendRef,
      resumeSessionsFallbackTimerRef, queueSyncSuppressUntilRef,
    },
    lifecycle: { refs: lifecycleRefs, setStatus: setLifecycleStatus },
    patchSessionCache,
    setLiveSessions,
    socketUrl,
    buildSocketAuth,
  } = options;

  const sendRemoteExec = React.useCallback((payload: any) => {
    const socket = viewerWsRef.current;
    if (!socket || !socket.connected || !lifecycleRefs.activeSessionId.current) {
      setLifecycleStatus("Not connected to a live session");
      return false;
    }
    const command = payload && typeof payload === "object" && typeof payload.command === "string" ? payload.command : null;
    if (command === "end_session") {
      setLifecycleStatus("Ending session…");
    } else if (command === "compact") {
      setLifecycleStatus("Compacting…");
    } else if (command === "abort") {
      // Optimistically mark as inactive so the UI updates immediately
      // instead of waiting for the next heartbeat cycle.
      setAgentActive(false);
      patchSessionCache({ agentActive: false });
      // Also update the sidebar's live session list so the session row
      // transitions from "active" to "completed unread" without waiting
      // for the hub's next session_status heartbeat.
      const sid = lifecycleRefs.activeSessionId.current;
      if (sid) {
        setLiveSessions((prev) =>
          prev.map((s) => (s.sessionId === sid ? { ...s, isActive: false } : s)),
        );
      }
    }
    try {
      const { type: _type, ...rest } = payload;
      socket.emit("exec", rest);
      return true;
    } catch {
      setLifecycleStatus("Failed to send command");
      return false;
    }
  }, []);

  /** Respond to a plugin trust prompt from the worker. */
  const respondPluginTrust = React.useCallback((trusted: boolean) => {
    const prompt = pluginTrustPrompt;
    if (!prompt) return;
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "plugin_trust_response",
      promptId: prompt.promptId,
      trusted,
    });
    // Only dismiss the banner if the send succeeded
    if (ok !== false) {
      setPluginTrustPrompt(null);
    }
  }, [sendRemoteExec, pluginTrustPrompt]);

  /**
   * End a session by session ID. If it's the currently active session the
   * existing viewer socket is used; otherwise a temporary socket is opened
   * for just the exec and then disconnected.
   */
  const handleEndSession = React.useCallback((sessionId: string) => {
    // Active session: reuse the existing viewer socket
    if (sessionId === lifecycleRefs.activeSessionId.current && viewerWsRef.current?.connected) {
      sendRemoteExec({
        type: "exec",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: "end_session",
      });
      return;
    }

    // Non-active session: open a temporary viewer socket, fire the exec, disconnect.
    // We wait for the exec_result confirmation (or a generous timeout) instead of
    // blindly disconnecting after 500ms, which was too aggressive and caused the
    // exec to be dropped when the server was still processing.
    const tempSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> = io(socketUrl("/viewer"), {
      auth: buildSocketAuth({
        sessionId,
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        clientVersion: UI_VERSION,
      }),
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    const cleanup = () => tempSocket.disconnect();
    const timeout = setTimeout(cleanup, 10_000);

    tempSocket.on("connected", () => {
      clearTimeout(timeout);
      const execId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // Listen for exec_result confirmation before disconnecting
      const resultTimeout = setTimeout(cleanup, 5_000); // fallback if no reply
      tempSocket.on("exec_result", (data) => {
        if (data && data.id === execId) {
          clearTimeout(resultTimeout);
          cleanup();
        }
      });

      tempSocket.emit("exec", {
        id: execId,
        command: "end_session",
      });
    });

    tempSocket.on("connect_error", () => {
      clearTimeout(timeout);
      cleanup();
    });
  }, [sendRemoteExec]);


  /**
   * Fetch persisted sessions from the server `/api/sessions` endpoint.
   * Used as a fallback when no active session exists (can't use runner-side
   * list_resume_sessions). Returns sessions from ALL runners.
   */
  const requestPersistedSessions = React.useCallback(async (cursor?: string) => {
    setResumeSessionsLoading(true);
    const isAppend = !!cursor;
    try {
      const params = new URLSearchParams({ includePersisted: "1", limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/sessions?${params}`, { credentials: "include" });
      if (!res.ok) {
        setResumeSessionsLoading(false);
        return;
      }
      const data = await res.json() as {
        persistedSessions?: PersistedSessionRow[];
        nextCursor?: string | null;
      };
      const persisted = Array.isArray(data.persistedSessions) ? data.persistedSessions : [];
      const mapped = mapPersistedSessions(persisted);

      const nextCursor = typeof data.nextCursor === "string" ? data.nextCursor : null;
      if (isAppend) {
        setResumeSessions((prev) => appendUniqueResumeSessions(prev, mapped));
      } else {
        setResumeSessions(mapped);
      }
      setResumeSessionsNextCursor(nextCursor);
      historyIsServerSourcedRef.current = true;
    } catch {
      // Silently fail — user just sees no sessions
    } finally {
      setResumeSessionsLoading(false);
    }
  }, []);

  const requestResumeSessions = React.useCallback((cursor?: string) => {
    // If no active session, fall back to server-side persisted sessions
    if (!lifecycleRefs.activeSessionId.current) {
      void requestPersistedSessions(cursor);
      return true; // Signal that a request was initiated
    }
    historyIsServerSourcedRef.current = false;
    setResumeSessionsLoading(true);
    resumeSessionsAppendRef.current = !!cursor;
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "list_resume_sessions",
      ...(cursor ? { cursor } : {}),
    });
    if (!ok) {
      setResumeSessionsLoading(false);
      resumeSessionsAppendRef.current = false;
      return ok;
    }
    // Runner didn't answer within 5s (stale/dead CLI) — fall back to the
    // server's persisted session list so history isn't stuck on a spinner.
    if (resumeSessionsFallbackTimerRef.current) clearTimeout(resumeSessionsFallbackTimerRef.current);
    resumeSessionsFallbackTimerRef.current = setTimeout(() => {
      resumeSessionsFallbackTimerRef.current = null;
      resumeSessionsAppendRef.current = false;
      void requestPersistedSessions(cursor);
    }, 5000);
    return ok;
  }, [sendRemoteExec, requestPersistedSessions]);

  const requestForkMessages = React.useCallback(() => {
    setForkMessagesLoading(true);
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "get_fork_messages",
    });
    if (!ok) setForkMessagesLoading(false);
    return ok;
  }, [sendRemoteExec, setForkMessagesLoading]);

  const refreshUsage = React.useCallback(() => {
    if (usageRefreshing) return false;
    setUsageRefreshing(true);
    setLifecycleStatus("Refreshing usage…");
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "refresh_usage",
    });
    if (!ok) {
      setUsageRefreshing(false);
    }
    return ok;
  }, [sendRemoteExec, usageRefreshing]);

  /**
   * Apply a local queue mutation and push the full replacement list to the
   * runner (set_queued_messages) so pi's pending queue actually changes —
   * without this, edits/removals were cosmetic and the runner still
   * delivered the original messages.
   */
  const syncQueueToRunner = React.useCallback((next: QueuedMessage[]) => {
    queueSyncSuppressUntilRef.current = Date.now() + QUEUE_SYNC_SUPPRESS_MS;
    setMessageQueue(next);
    patchSessionCache({ messageQueue: next });
    sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "set_queued_messages",
      messages: next.map((m) => m.text),
    });
  }, [patchSessionCache, sendRemoteExec]);

  const removeQueuedMessage = React.useCallback((id: string) => {
    syncQueueToRunner(messageQueue.filter((m) => m.id !== id));
  }, [messageQueue, syncQueueToRunner]);

  const editQueuedMessage = React.useCallback((id: string, newText: string) => {
    syncQueueToRunner(messageQueue.map((m) => (m.id === id ? { ...m, text: newText } : m)));
  }, [messageQueue, syncQueueToRunner]);

  const clearMessageQueue = React.useCallback(() => {
    syncQueueToRunner([]);
  }, [syncQueueToRunner]);

  const selectModel = React.useCallback((model: ConfiguredModelInfo) => {
    const socket = viewerWsRef.current;
    if (!socket || !socket.connected || !lifecycleRefs.activeSessionId.current) {
      setLifecycleStatus("Not connected to a live session");
      return;
    }

    try {
      setIsChangingModel(true);
      setLifecycleStatus(`Switching model to ${model.provider}/${model.id}…`);
      socket.emit("model_set", { provider: model.provider, modelId: model.id });
      setModelSelectorOpen(false);
    } catch {
      setIsChangingModel(false);
      setLifecycleStatus("Failed to change model");
    }
  }, []);

  return {
    sendRemoteExec,
    respondPluginTrust,
    handleEndSession,
    requestResumeSessions,
    requestForkMessages,
    refreshUsage,
    removeQueuedMessage,
    editQueuedMessage,
    clearMessageQueue,
    selectModel,
  };
}
