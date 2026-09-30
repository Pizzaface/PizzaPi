import * as React from "react";
import { parseSpawnResponse, type ApprovalDecision, type MetaPendingApproval } from "@pizzapi/protocol";
import type { HubSession } from "@/components/SessionSidebar";
import { clearAnsweredApproval } from "@/lib/meta-state-apply";
import { removeMessagesByStableKey } from "@/lib/mcp-auth-banners";
import { mapUserError } from "@/lib/user-error-message";
import type { SessionUiCacheEntry } from "@/lib/types";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import type { SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { SessionInputMessage, StateSetter } from "./types";

function isPayloadObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface SessionActionsOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycle: UseSessionLifecycleResult;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  sendSessionInput: (message: SessionInputMessage) => Promise<boolean>;
  activeSessionId: string | null;
  activeSessionInfo: { runnerId: string | null; cwd: string } | null;
  liveSessions: HubSession[];
  handleOpenSession: (id: string) => void;
  setHistoryOpen: StateSetter<boolean>;
}

/**
 * Viewer actions surfaced by SessionViewer / the history palette: child
 * trigger responses, spawning agent sessions, approval decisions, MCP OAuth
 * paste / dismiss / disable, and resuming a session from history.
 */
export function useSessionActions(options: SessionActionsOptions) {
  const {
    session: {
      sessionState: { pendingApproval, resumeSessions },
      messagesRef, setMessages, setMcpOAuthPastes, setPendingApproval,
    },
    refs: { viewerWsRef, injectedMessagesRef },
    lifecycle: {
      refs: lifecycleRefs,
      setStatus: setLifecycleStatus,
      spawnSession: lifecycleSpawnSession,
      waitForSessionToGoLive,
    },
    patchSessionCache,
    sendSessionInput,
    activeSessionId,
    activeSessionInfo,
    liveSessions,
    handleOpenSession,
    setHistoryOpen,
  } = options;

  // ── Respond to a trigger from a child session ─────────────────────────────
  const handleTriggerResponse = React.useCallback((triggerId: string, response: string, action?: string, sourceSessionId?: string): Promise<boolean> => {
    const socket = viewerWsRef.current;
    const sessionId = lifecycleRefs.activeSessionId.current;
    if (!socket || !socket.connected || !sessionId) {
      setLifecycleStatus("Not connected to a live session");
      return Promise.resolve(false);
    }

    // Use the child's sourceSessionId (extracted from the trigger comment) as
    // targetSessionId so the server can route directly to the child session,
    // bypassing the parent's in-memory receivedTriggers map. This makes
    // delivery resilient to parent reconnects/resumes where the map is gone.
    // Falls back to the parent session ID for legacy triggers without source.
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const settle = (success: boolean, message?: string) => {
        if (resolved) return;
        resolved = true;
        if (message) setLifecycleStatus(message);
        errorCleanup();
        resolve(success);
      };

      // Listen for trigger_error events — the server emits these immediately
      // when the target child is missing, unauthorized, or relay delivery fails.
      // Each error carries its triggerId so concurrent trigger submissions
      // don't interfere with each other (unlike the shared "error" event).
      const onTriggerError = (data: any) => {
        if (data?.triggerId === triggerId) {
          settle(false, "Trigger delivery failed — try again");
        }
      };
      socket.on("trigger_error", onTriggerError);
      const errorCleanup = () => { socket.off("trigger_error", onTriggerError); };

      // Send with Socket.IO ack — server only acks on successful delivery.
      socket.emit("trigger_response", {
        triggerId,
        response,
        ...(action ? { action } : {}),
        targetSessionId: sourceSessionId ?? sessionId,
      }, () => {
        // Server acknowledged successful delivery
        settle(true);
      });
      // If no ack arrives within 5s, treat as a failed delivery
      setTimeout(() => {
        settle(false, "Trigger response may not have been delivered — try again");
      }, 5000);
    });
  }, []);

  // ── Spawn a new session as a specific agent ─────────────────────────────
  const handleSpawnAgentSession = React.useCallback(async (agent: {
    name: string;
    description?: string;
    systemPrompt?: string;
    tools?: string;
    disallowedTools?: string;
  }) => {
    // Determine runner/cwd from the current active session
    const sessionInfo = activeSessionId
      ? liveSessions.find((s) => s.sessionId === activeSessionId)
      : null;
    const runnerId = sessionInfo?.runnerId;
    const cwd = sessionInfo?.cwd;

    if (!runnerId) {
      setLifecycleStatus("No runner available — open a session first");
      return;
    }

    try {
      const sessionId = await lifecycleSpawnSession(runnerId, cwd, {
        name: agent.name,
        ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
      });
      handleOpenSession(sessionId);
    } catch (err) {
      const mapped = mapUserError({
        error: err,
        context: "session_spawn",
      });
      console.error("Failed to spawn agent session:", err);
      setLifecycleStatus(mapped.userMessage);
    }
  }, [activeSessionId, liveSessions, lifecycleSpawnSession, handleOpenSession]);

  const handleApprovalDecision = React.useCallback(async (decision: ApprovalDecision) => {
    const promptId = pendingApproval?.promptId;
    const payload = JSON.stringify({ ...decision, ...(promptId ? { promptId } : {}) });
    const ok = await sendSessionInput(payload);
    // Only clear the prompt we answered; a follow-up prompt
    // (e.g. MCP URL resume) may already have replaced it.
    if (ok !== false) setPendingApproval((current: MetaPendingApproval | null) => clearAnsweredApproval(current, promptId));
    return ok;
  }, [pendingApproval, sendSessionInput, setPendingApproval]);

  /** Drop the MCP auth banner (injected + rendered) and paste prompt for a server. */
  const removeMcpAuthPrompt = React.useCallback((serverName: string) => {
    setMcpOAuthPastes((prev) => prev.filter((p) => p.serverName !== serverName));
    const stableKey = `mcp_auth:${serverName}`;
    injectedMessagesRef.current = removeMessagesByStableKey(injectedMessagesRef.current, stableKey);
    const next = removeMessagesByStableKey(messagesRef.current, stableKey);
    if (next.length !== messagesRef.current.length) {
      setMessages(next);
      patchSessionCache({ messages: next });
    }
  }, [patchSessionCache]);

  const handleMcpOAuthPaste = React.useCallback((nonce: string, code: string, state?: string) => {
    const socket = viewerWsRef.current;
    if (!socket?.connected) return Promise.resolve({ ok: false, error: "Not connected" });
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: "Delivery timed out" }), 5000);
      socket.emit("mcp_oauth_paste", { nonce, code, state }, (result: any) => {
        clearTimeout(timeout);
        resolve(result && typeof result === "object" ? result : { ok: false, error: "Invalid response" });
      });
    });
  }, []);

  const handleMcpOAuthPasteDismiss = React.useCallback((serverName: string) => {
    removeMcpAuthPrompt(serverName);
  }, [removeMcpAuthPrompt]);

  const handleMcpServerDisable = React.useCallback((serverName: string) => {
    removeMcpAuthPrompt(serverName);
    const socket = viewerWsRef.current;
    if (socket?.connected) {
      socket.emit("exec", {
        id: `disable-mcp-${serverName}-${Date.now()}`,
        command: "mcp_toggle_server",
        serverName,
        disabled: true,
      });
    }
  }, [removeMcpAuthPrompt]);

  const handleResumeFromHistory = React.useCallback(async (sessionId: string) => {
    const session = resumeSessions.find((s) => s.id === sessionId);
    if (!session) return;

    // Determine runnerId: prefer session-level (server-sourced), fall back to active session's runner
    const runnerId = session.runnerId || activeSessionInfo?.runnerId;
    if (!runnerId) {
      setLifecycleStatus("No runner available for this session");
      return;
    }
    setHistoryOpen(false);
    setLifecycleStatus("Resuming session…");
    try {
      // Server-sourced sessions don't have the .jsonl path — send resumeId
      // so the runner daemon resolves the path from the session ID.
      const payload: any = {
        runnerId,
        ...(session.serverSourced
          ? { resumeId: session.id }
          : { resumePath: session.path }),
        ...(session.cwd ? { cwd: session.cwd } : {}),
      };
      const res = await fetch("/api/runners/spawn", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const error = isPayloadObject(body) && typeof body.error === "string" ? body.error : undefined;
        setLifecycleStatus(error ?? "Failed to resume session");
        return;
      }
      const parsed = parseSpawnResponse(body);
      if (!parsed.ok) {
        setLifecycleStatus(parsed.error);
        return;
      }
      const live = await waitForSessionToGoLive(parsed.value.sessionId, 30_000);
      if (!live) {
        setLifecycleStatus("Session is starting…");
        return;
      }
      handleOpenSession(parsed.value.sessionId);
      setLifecycleStatus("Connecting…");
    } catch (err) {
      setLifecycleStatus("Failed to resume session");
      console.error("Resume session error:", err);
    }
  }, [resumeSessions, activeSessionInfo?.runnerId, setLifecycleStatus, setHistoryOpen, waitForSessionToGoLive, handleOpenSession]);

  return {
    handleTriggerResponse,
    handleSpawnAgentSession,
    handleApprovalDecision,
    handleMcpOAuthPaste,
    handleMcpOAuthPasteDismiss,
    handleMcpServerDisable,
    handleResumeFromHistory,
  };
}
