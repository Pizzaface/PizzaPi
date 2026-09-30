import * as React from "react";
import type { Socket } from "socket.io-client";
import type {
  ViewerServerToClientEvents,
  ViewerClientToServerEvents,
  HubServerToClientEvents,
  HubClientToServerEvents,
} from "@pizzapi/protocol";
import type { RelayMessage } from "@/components/SessionViewer";
import type { SessionInputMessage } from "./types";

/**
 * Mutable, render-independent state shared by the viewer/hub socket handlers
 * and the session command callbacks. Every entry is a stable `useRef`; the
 * returned object itself is rebuilt each render, so never list it as a
 * dependency — destructure the refs you need instead.
 */
export function useViewerRefs() {
  // Sequence tracking for gap detection
  const lastSeqRef = React.useRef<number | null>(null);

  // Stale-connection detection: track the last time any event arrived from the relay.
  const lastViewerEventAtRef = React.useRef<number>(0);
  const staleCheckTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // When we last asked the server to hydrate, or null once hydration settled.
  // A hydration request has no ack, so this is the only way to notice one that
  // was answered with nothing.
  const hydrationRequestedAtRef = React.useRef<number | null>(null);
  const hydrationStallTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const hydrationRetriesRef = React.useRef(0);

  // Track which MCP startup report timestamps have already been rendered
  // to avoid duplicates when heartbeats re-deliver the same report.
  const renderedMcpReportTsRef = React.useRef<number | null>(null);

  // Holds an MCP startup report that arrived (via hub state_snapshot) before
  // session_active hydration completed. Flushed when hydration finishes.
  // Needed for the new slim-heartbeat CLI that no longer retries in every heartbeat.
  const pendingMcpReportRef = React.useRef<Record<string, unknown> | null>(null);

  // Locally-injected messages (e.g. MCP auth banners) that must survive
  // wholesale setMessages replacements from session_active / agent_end.
  const injectedMessagesRef = React.useRef<RelayMessage[]>([]);

  // Tracks the highest meta state version seen per session, to prevent stale
  // state_snapshot from rolling back state already updated by meta_event.
  const metaVersionsRef = React.useRef<Map<string, number>>(new Map());
  // When true, the viewer socket should treat hub meta rooms as the sole
  // authoritative source for meta state.
  const metaSourceHubRef = React.useRef(false);

  // Tracks which session's meta room we've joined so we can unsubscribe when needed.
  const prevMetaSessionRef = React.useRef<string | null>(null);
  const confirmedMetaLiveSessionIdsRef = React.useRef<Set<string>>(new Set());
  // Background (non-active) live sessions whose meta rooms we've joined.
  const backgroundMetaIdsRef = React.useRef<Set<string>>(new Set());

  // Chunked session delivery: live deltas that arrive while the historical
  // snapshot is loading are replayed after the snapshot is installed so the
  // current turn is not lost. (Chunk state itself is owned by
  // lifecycleRefs.chunked / lifecycleRefs.lastCompletedSnapshot.)
  const deferredChunkEventsRef = React.useRef<unknown[]>([]);

  const viewerWsRef = React.useRef<Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null>(null);
  const paginationStateRef = React.useRef<{
    totalMessages: number;
    hasMore: boolean;
    oldestLoadedIndex: number;
  } | null>(null);
  const hubSocketRef = React.useRef<Socket<HubServerToClientEvents, HubClientToServerEvents> | null>(null);

  // PATCH(pizzapi): relay ui_notify events → toast. Installed by the hub
  // socket effect; a no-op until then.
  const handleUiNotifyRef = React.useRef<(payload: { message: string; notifyType?: "info" | "warning" | "error" }) => void>(() => {});

  // Tracks whether the in-flight list_resume_sessions request is a "load more" (append) vs fresh load
  const resumeSessionsAppendRef = React.useRef(false);
  // Fallback timer: if the runner never answers list_resume_sessions (stale or
  // dead CLI), fall back to server-persisted sessions instead of spinning forever.
  const resumeSessionsFallbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether the current history data came from the server fallback (vs runner-side).
  // When true, resume uses `resumeId` instead of `resumePath`.
  const historyIsServerSourcedRef = React.useRef(false);

  // Ignore runner queue syncs briefly after a local mutation / optimistic add
  // so a stale in-flight heartbeat can't clobber state the runner hasn't
  // applied yet. The next heartbeat after the window restores authority.
  const queueSyncSuppressUntilRef = React.useRef(0);

  // Messages submitted while the session was still hydrating (e.g. the runner
  // was loading MCP servers). Flushed once the snapshot completes.
  const pendingHydrationInputsRef = React.useRef<Array<{ sessionId: string; message: SessionInputMessage; resolve: (delivered: boolean) => void }>>([]);

  return {
    lastSeqRef,
    lastViewerEventAtRef,
    staleCheckTimerRef,
    hydrationRequestedAtRef,
    hydrationStallTimerRef,
    hydrationRetriesRef,
    renderedMcpReportTsRef,
    pendingMcpReportRef,
    injectedMessagesRef,
    metaVersionsRef,
    metaSourceHubRef,
    prevMetaSessionRef,
    confirmedMetaLiveSessionIdsRef,
    backgroundMetaIdsRef,
    deferredChunkEventsRef,
    viewerWsRef,
    paginationStateRef,
    hubSocketRef,
    handleUiNotifyRef,
    resumeSessionsAppendRef,
    resumeSessionsFallbackTimerRef,
    historyIsServerSourcedRef,
    queueSyncSuppressUntilRef,
    pendingHydrationInputsRef,
  };
}

export type ViewerRefs = ReturnType<typeof useViewerRefs>;
