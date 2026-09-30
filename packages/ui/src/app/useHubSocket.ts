import * as React from "react";
import { io, type Socket } from "socket.io-client";
import type { HubServerToClientEvents, HubClientToServerEvents } from "@pizzapi/protocol";
import { SOCKET_PROTOCOL_VERSION, parseHubStateSnapshot, parseHubMetaEvent } from "@pizzapi/protocol";
import type { HubSession } from "@/components/SessionSidebar";
import { logFrontendEvent } from "@/lib/frontend-log";
import { getConfirmedMetaSubscriptionTargets } from "@/lib/meta-subscriptions";
import { metaEventToStatePatch } from "@/lib/meta-state-apply";
import type { SessionLifecycleRefs } from "@/lib/use-session-lifecycle";
import { UI_VERSION } from "./constants";
import type { ViewerRefs } from "./useViewerRefs";
import type { StateSetter, Toast } from "./types";
import type { useSessionMetaAppliers } from "./useSessionMetaAppliers";

export interface HubSocketOptions {
  /** Authenticated user id, or null before auth resolves (socket not created). */
  hubAuthUserId: string | null;
  socketUrl: (namespace: string) => string;
  buildSocketAuth: (extra: Record<string, unknown>) => Record<string, unknown>;
  refs: ViewerRefs;
  lifecycleRefs: SessionLifecycleRefs;
  activeSessionId: string | null;
  liveSessions: HubSession[];
  appliers: ReturnType<typeof useSessionMetaAppliers>;
  checkVersionCompatibility: () => Promise<void>;
  pushToast: (message: string, type: Toast["type"]) => void;
  setSessionsAwaitingInput: StateSetter<Set<string>>;
  setSessionsCompacting: StateSetter<Set<string>>;
}

/**
 * The /hub socket: session meta state (snapshots + versioned meta events) for
 * the active session, sidebar badges (awaiting input / compacting) for every
 * live session, and meta-room subscriptions for active + background sessions.
 *
 * Returns the socket as state so HubSocketContext consumers re-render when it
 * changes.
 */
export function useHubSocket(options: HubSocketOptions) {
  const {
    hubAuthUserId,
    socketUrl,
    buildSocketAuth,
    refs: {
      hubSocketRef, metaVersionsRef, prevMetaSessionRef, backgroundMetaIdsRef,
      confirmedMetaLiveSessionIdsRef, pendingMcpReportRef, handleUiNotifyRef,
    },
    lifecycleRefs,
    activeSessionId,
    liveSessions,
    appliers: { applyMetaStateSnapshot, applyMetaPatch, applyMcpReport },
    checkVersionCompatibility,
    pushToast,
    setSessionsAwaitingInput,
    setSessionsCompacting,
  } = options;

  // Tracked as state so HubSocketContext consumers re-render when the socket changes.
  const [hubSocket, setHubSocket] = React.useState<Socket<HubServerToClientEvents, HubClientToServerEvents> | null>(null);
  const [metaInventoryVersion, setMetaInventoryVersion] = React.useState(0);

  React.useEffect(() => {
    confirmedMetaLiveSessionIdsRef.current = new Set(liveSessions.map((s) => s.sessionId));
    setMetaInventoryVersion((version) => version + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessions]);

  React.useEffect(() => {
    if (!hubAuthUserId) return;
    const socket = io(socketUrl("/hub"), {
      withCredentials: true,
      // WebSocket first: the default polling→upgrade handshake costs 2-3 extra
      // RTTs on every connect AND reconnect. Polling stays as a fallback for
      // proxies that block WebSockets.
      transports: ["websocket", "polling"],
      auth: buildSocketAuth({
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        clientVersion: UI_VERSION,
      }),
    });
    hubSocketRef.current = socket;
    setHubSocket(socket);

    const handleStateSnapshot = (raw: unknown) => {
      const parsed = parseHubStateSnapshot(raw);
      if (!parsed.ok) {
        logFrontendEvent("hub", "warning", "Malformed state snapshot", parsed.error);
        return;
      }
      const { sessionId, state } = parsed.value;
      const currentSessionId = lifecycleRefs.activeSessionId.current;

      // For background sessions: extract pendingQuestion/pendingPlan from the
      // initial state_snapshot so badges are correct on load/reconnect even
      // when the session is already blocked waiting for user input.
      if (sessionId !== currentSessionId) {
        if (Object.prototype.hasOwnProperty.call(state, "pendingQuestion") ||
            Object.prototype.hasOwnProperty.call(state, "pendingPlan")) {
          setSessionsAwaitingInput((prev) => {
            const next = new Set(prev);
            if (state.pendingQuestion || state.pendingPlan) {
              next.add(sessionId);
            } else {
              next.delete(sessionId);
            }
            return next;
          });
        }
        if (typeof state.isCompacting === "boolean") {
          setSessionsCompacting((prev) => {
            const next = new Set(prev);
            if (state.isCompacting) {
              next.add(sessionId);
            } else {
              next.delete(sessionId);
            }
            return next;
          });
        }
        return;
      }

      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (state.version < seen) return;
      metaVersionsRef.current.set(sessionId, state.version);
      applyMetaStateSnapshot(state);
    };

    const handleMetaEvent = (raw: unknown) => {
      const parsed = parseHubMetaEvent(raw);
      if (!parsed.ok) {
        logFrontendEvent("hub", "warning", "Malformed meta event", parsed.error);
        return;
      }
      const { sessionId, version, event } = parsed.value;

      // Update the sidebar pending-question badge for ANY session's meta event,
      // not just the active one.  Background sessions emit pendingQuestion
      // and pendingPlan updates into their own meta rooms; the badge must
      // reflect all of them.
      if (event.type === "question_pending" || event.type === "question_cleared" ||
          event.type === "plan_pending" || event.type === "plan_cleared") {
        setSessionsAwaitingInput((prev) => {
          const next = new Set(prev);
          if (event.type === "question_cleared" || event.type === "plan_cleared") {
            next.delete(sessionId);
          } else {
            next.add(sessionId);
          }
          return next;
        });
      }

      // Track compaction state for ANY session's meta event (same pattern as
      // sessionsAwaitingInput above) so the sidebar shows the yellow chase
      // indicator even for background sessions.
      if (event.type === "compact_started" || event.type === "compact_ended") {
        setSessionsCompacting((prev) => {
          const next = new Set(prev);
          if (event.type === "compact_started") {
            next.add(sessionId);
          } else {
            next.delete(sessionId);
          }
          return next;
        });
      }

      const currentSessionId = lifecycleRefs.activeSessionId.current;
      if (sessionId !== currentSessionId) return;
      const seen = metaVersionsRef.current.get(sessionId) ?? 0;
      if (version <= seen) return;
      metaVersionsRef.current.set(sessionId, version);
      applyMetaPatch(metaEventToStatePatch(event));
      if (event.type === "mcp_startup_report" && event.report) {
        // Buffer if session not yet hydrated — the new slim CLI no longer retries
        // in heartbeats, so without this the report would be lost for live events
        // that race session_active delivery.
        if (lifecycleRefs.hydrated.current) {
          applyMcpReport(event.report);
        } else {
          pendingMcpReportRef.current = event.report as Record<string, unknown>;
        }
      }
    };

    // Re-subscribe to ALL meta rooms after non-recovered reconnects (e.g., server
    // restart). Without this, the client stops receiving meta_event updates until
    // the user switches sessions or reloads.
    // Also clear stored meta versions so the first state_snapshot/meta_event
    // arriving after reconnect is not dropped as "stale" — the server resets its
    // version counter to 0 on restart, so any previously-seen version would cause
    // all new events to be silently ignored.
    const handleReconnect = () => {
      metaVersionsRef.current.clear();
      prevMetaSessionRef.current = null;
      backgroundMetaIdsRef.current.clear();
      confirmedMetaLiveSessionIdsRef.current = new Set();
      setMetaInventoryVersion((version) => version + 1);
      void checkVersionCompatibility();
    };

    // PATCH(pizzapi): Handle ui_notify events from the runner (ctx.ui.notify)
    const handleUiNotify = (payload: { message: string; notifyType?: "info" | "warning" | "error" }) => {
      // Auto-dismissed after 5 seconds by pushToast.
      pushToast(payload.message, payload.notifyType || "info");
    };
    handleUiNotifyRef.current = handleUiNotify;

    socket.on("state_snapshot", handleStateSnapshot);
    socket.on("meta_event", handleMetaEvent);
    socket.on("connect", handleReconnect);

    return () => {
      socket.off("state_snapshot", handleStateSnapshot);
      socket.off("meta_event", handleMetaEvent);
      socket.off("connect", handleReconnect);
      socket.off("ui_notify", handleUiNotify);
      socket.disconnect();
      hubSocketRef.current = null;
      setHubSocket(null);
    };
  }, [hubAuthUserId, applyMetaStateSnapshot, applyMetaPatch, applyMcpReport, checkVersionCompatibility]);

  React.useEffect(() => {
    const hubSock = hubSocketRef.current;
    if (!hubSock) return;

    const { activeSessionId: confirmedActiveSessionId } = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: liveSessions.map((s) => s.sessionId),
      confirmedLiveSessionIds: confirmedMetaLiveSessionIdsRef.current,
      activeSessionId,
    });
    const prevId = prevMetaSessionRef.current;

    if (prevId && prevId !== confirmedActiveSessionId) {
      hubSock.emit("unsubscribe_session_meta", { sessionId: prevId });
      metaVersionsRef.current.delete(prevId);
    }

    if (confirmedActiveSessionId) {
      if (prevId !== confirmedActiveSessionId) {
        hubSock.emit("subscribe_session_meta", { sessionId: confirmedActiveSessionId });
      }
      prevMetaSessionRef.current = confirmedActiveSessionId;
    } else {
      prevMetaSessionRef.current = null;
    }
  }, [hubSocket, activeSessionId, liveSessions, metaInventoryVersion]);

  // Subscribe to meta rooms for ALL live sessions (not just the active one) so
  // that background sessions can update the sidebar pending-question badge.
  // The active session's subscription is managed by the effect above; this
  // effect handles every other live session.
  React.useEffect(() => {
    const hubSock = hubSocketRef.current;
    if (!hubSock) return;

    const { backgroundSessionIds } = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: liveSessions.map((s) => s.sessionId),
      confirmedLiveSessionIds: confirmedMetaLiveSessionIdsRef.current,
      activeSessionId,
    });
    const currentIds = new Set(backgroundSessionIds);
    const prev = backgroundMetaIdsRef.current;

    // Unsubscribe from sessions that are no longer in the live list.
    // Do NOT unsubscribe the active session — it may have just been promoted
    // from background and its subscription is now managed by the active-session
    // effect above. Emitting unsubscribe here would silently break all meta
    // updates for the newly-opened session.
    for (const id of prev) {
      if (!currentIds.has(id)) {
        if (id !== activeSessionId) {
          hubSock.emit("unsubscribe_session_meta", { sessionId: id });
        }
        prev.delete(id);
      }
    }

    // Subscribe to newly-appeared background sessions.
    for (const id of currentIds) {
      if (!prev.has(id)) {
        hubSock.emit("subscribe_session_meta", { sessionId: id });
        prev.add(id);
      }
    }
  }, [hubSocket, liveSessions, activeSessionId, metaInventoryVersion]);

  return hubSocket;
}
