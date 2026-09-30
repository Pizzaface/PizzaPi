import * as React from "react";
import type { RelayMessage } from "@/components/SessionViewer";
import { classifySessionInput } from "@/lib/session-empty-state";
import { emitInputWithAck } from "@/lib/input-delivery";
import {
  beginInputAttempt,
  completeInputAttempt,
  failInputAttempt,
  shouldDeduplicateInput,
  type InputDedupeState,
} from "@/lib/input-dedupe";
import type { QueuedMessage, SessionUiCacheEntry } from "@/lib/types";
import type { UseSessionLifecycleResult } from "@/lib/use-session-lifecycle";
import { matchesViewerGeneration, matchesViewerSession } from "@/lib/viewer-switch";
import { QUEUE_SYNC_SUPPRESS_MS } from "./constants";
import type { SessionStateApi } from "./useSessionState";
import type { ViewerRefs } from "./useViewerRefs";
import type { SessionInputMessage } from "./types";

export interface SessionInputOptions {
  session: SessionStateApi;
  refs: ViewerRefs;
  lifecycle: UseSessionLifecycleResult;
  patchSessionCache: (patch: Partial<SessionUiCacheEntry>) => void;
  isCompacting: boolean;
  loadingOlderMessages: boolean;
  setLoadingOlderMessages: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Composer → runner delivery: `sendSessionInput` (hydration queueing, dedupe,
 * attachment upload with cross-session-switch guard, ack'd emit, optimistic
 * steer / follow-up queue entries), the hydration-queue flush, and
 * `requestOlderMessages` pagination.
 */
export function useSessionInput(options: SessionInputOptions) {
  const {
    session: { messagesRef, setMessages, setMessageQueue },
    refs: { viewerWsRef, paginationStateRef, queueSyncSuppressUntilRef, pendingHydrationInputsRef },
    lifecycle,
    patchSessionCache,
    isCompacting,
    loadingOlderMessages,
    setLoadingOlderMessages,
  } = options;
  const {
    refs: lifecycleRefs,
    viewerStatus,
    setStatus: setLifecycleStatus,
  } = lifecycle;

  // Dedup guard: prevent sending the exact same message text within a short window.
  const inputDedupeRef = React.useRef<InputDedupeState | null>(null);
  const inputAttemptIdRef = React.useRef(0);
  const fileIdentityRef = React.useRef(new WeakMap<File, number>());
  const nextFileIdentityRef = React.useRef(0);

  const requestOlderMessages = React.useCallback(() => {
    const socket = viewerWsRef.current;
    const sessionId = lifecycleRefs.activeSessionId.current;
    const pagination = paginationStateRef.current;
    if (!socket || !socket.connected || !sessionId || !pagination?.hasMore || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    socket.emit("load_messages", {
      sessionId,
      before: pagination.oldestLoadedIndex,
      limit: 50,
    });
  }, [loadingOlderMessages]);

  const sendSessionInput = React.useCallback(async (message: SessionInputMessage) => {
    const socket = viewerWsRef.current;
    const sessionId = lifecycleRefs.activeSessionId.current;
    // Capture generation so we can detect switch-away during async upload.
    const capturedGeneration = lifecycleRefs.generation.current;
    if (!sessionId) {
      setLifecycleStatus("Not connected to a live session");
      return false;
    }
    if (isCompacting) {
      setLifecycleStatus("Compacting…");
      return false;
    }
    const gate = classifySessionInput(sessionId, viewerStatus, isCompacting, lifecycleRefs.awaitingSnapshot.current);
    if (gate === "queue") {
      // Session is still hydrating (usually MCP servers loading on the
      // runner). Queue the message and flush it once the snapshot completes
      // instead of rejecting and forcing the user to retry.
      // PromptInput clears/revokes files only for a strict true result. The
      // queued send has not been delivered yet, so retain the files until the
      // flush can report actual delivery.
      return new Promise<boolean>((resolve) => {
        pendingHydrationInputsRef.current.push({ sessionId, message, resolve });
      });
    }
    if (gate === "reject") return false;
    if (!socket || !socket.connected) {
      setLifecycleStatus("Not connected to a live session");
      return false;
    }

    const payload = typeof message === "string" ? { text: message, files: [] } : message;
    const trimmed = payload.text.trim();

    const rawFiles = (payload.files ?? [])
      .filter((f) => typeof f?.url === "string" && f.url.length > 0)
      .map((f) => ({
        file: f.file instanceof File ? f.file : undefined,
        mediaType: typeof f.mediaType === "string" ? f.mediaType : undefined,
        filename: typeof f.filename === "string" ? f.filename : undefined,
        url: f.url as string,
      }));

    // Dedup only an identical text + file selection. File object identity is
    // enough to distinguish two same-caption submissions without reading the
    // files before upload; URL/name metadata covers non-File inputs.
    const fileKey = (payload.files ?? []).map((file) => {
      const identity = file.file
        ? (() => {
            let id = fileIdentityRef.current.get(file.file);
            if (id === undefined) {
              id = ++nextFileIdentityRef.current;
              fileIdentityRef.current.set(file.file, id);
            }
            return `file:${id}`;
          })()
        : `url:${file.url ?? ""}`;
      return `${identity}:${file.filename ?? ""}:${file.mediaType ?? ""}`;
    }).join("|");
    const dedupeKey = `${trimmed}\u0000${fileKey}`;
    const now = Date.now();
    if (shouldDeduplicateInput(inputDedupeRef.current, dedupeKey, now, 500)) {
      // A pending duplicate must not clear/revoke the caller's draft. A sent
      // duplicate is harmless and can report the same successful phase.
      return inputDedupeRef.current?.phase === "sent";
    }

    let attemptId: number | null = null;
    if (trimmed || rawFiles.length > 0) {
      attemptId = ++inputAttemptIdRef.current;
      inputDedupeRef.current = beginInputAttempt(dedupeKey, now, attemptId);
    }

    const failCurrentAttempt = () => {
      if (attemptId === null) return;
      inputDedupeRef.current = failInputAttempt(inputDedupeRef.current, attemptId);
    };

    const viewerStillMatches = () =>
      matchesViewerSession(lifecycleRefs.activeSessionId.current, sessionId) &&
      matchesViewerGeneration(lifecycleRefs.generation.current, capturedGeneration);
    const setAttachmentStatus = (status: string) => {
      if (viewerStillMatches()) setLifecycleStatus(status);
    };

    let attachments: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

    if (rawFiles.length > 0) {
      const uploaded: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

      for (const [index, file] of rawFiles.entries()) {
        const displayName = file.filename || `attachment-${index + 1}`;
        setAttachmentStatus(`Uploading attachment ${index + 1}/${rawFiles.length}: ${displayName}`);

        const formData = new FormData();
        try {
          const uploadFile = file.file
            ? new File([file.file], displayName, {
                type: file.mediaType || file.file.type || "application/octet-stream",
              })
            : await fetch(file.url)
                .then((res) => res.blob())
                .then(
                  (blob) =>
                    new File([blob], displayName, {
                      type: file.mediaType || blob.type || "application/octet-stream",
                    })
                );
          formData.append("files", uploadFile);
        } catch {
          setAttachmentStatus(`Failed to prepare attachment: ${displayName}`);
          failCurrentAttempt();
          return false;
        }

        try {
          const uploadRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
            method: "POST",
            body: formData,
            credentials: "include",
          });

          if (!uploadRes.ok) {
            const body = await uploadRes.json().catch(() => null);
            const message = body && typeof body.error === "string" ? body.error : `Upload failed for ${displayName}`;
            setAttachmentStatus(message);
            failCurrentAttempt();
            return false;
          }

          const body = await uploadRes.json().catch(() => null) as any;
          const first = Array.isArray(body?.attachments) ? body.attachments[0] : null;
          if (!first || typeof first.attachmentId !== "string") {
            setAttachmentStatus(`Upload failed for ${displayName}`);
            failCurrentAttempt();
            return false;
          }

          uploaded.push({
            attachmentId: first.attachmentId as string,
            filename: typeof first.filename === "string" ? first.filename : undefined,
            mediaType: typeof first.mimeType === "string" ? first.mimeType : undefined,
            size: typeof first.size === "number" ? first.size : undefined,
            expiresAt: typeof first.expiresAt === "string" ? first.expiresAt : undefined,
          });
        } catch {
          setAttachmentStatus(`Upload failed for ${displayName}`);
          failCurrentAttempt();
          return false;
        }
      }

      attachments = uploaded;
    }

    const deliverAs = typeof message === "object" ? message.deliverAs : undefined;
    const suppressOptimistic = typeof message === "object" && message.suppressOptimistic;

    // Guard: if the viewer switched sessions during the async upload, cancel.
    // Re-emitting to the wrong session would send A's attachment to B.
    if (!viewerStillMatches()) {
      failCurrentAttempt();
      return false;
    }

    if (attachments.length > 0) {
      setLifecycleStatus(`Uploaded ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}. Sending…`);
    }

    try {
      const delivered = await emitInputWithAck(socket, {
        text: trimmed,
        attachments,
        client: "web",
        requestId: crypto.randomUUID(),
        ...(deliverAs ? { deliverAs } : {}),
      });
      // The guard above still applies: emitInputWithAck does its own socket.emit("input", ...).
      if (!delivered) {
        setLifecycleStatus("Failed to send message");
        failCurrentAttempt();
        return false;
      }

      // Mark dedupe as sent only after the server and runner acknowledge delivery.
      if (attemptId !== null) {
        inputDedupeRef.current = completeInputAttempt(inputDedupeRef.current, attemptId, Date.now());
      }

      // Track queued messages when the agent is active
      if (deliverAs && trimmed && !suppressOptimistic) {
        if (deliverAs === "steer") {
          // Steer messages appear immediately in the conversation
          const now = Date.now();
          const optimisticSteerMessage: RelayMessage = {
            key: `user:steer:${now}:${Math.random().toString(16).slice(2)}`,
            role: "user",
            timestamp: now,
            content: trimmed,
          };
          const next = [...messagesRef.current, optimisticSteerMessage];
          setMessages(next);
          patchSessionCache({ messages: next });
          setLifecycleStatus("Steering message sent");
        } else {
          // Suppress runner queue syncs briefly — a heartbeat built before
          // the runner received this input would wipe the optimistic entry.
          queueSyncSuppressUntilRef.current = Date.now() + QUEUE_SYNC_SUPPRESS_MS;
          let nextQueue: QueuedMessage[] = [];
          setMessageQueue((prev) => {
            nextQueue = [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                text: trimmed,
                deliverAs,
                timestamp: Date.now(),
              },
            ];
            return nextQueue;
          });
          patchSessionCache({ messageQueue: nextQueue });
          setLifecycleStatus("Follow-up queued");
        }
      } else {
        setLifecycleStatus("Connected");
      }
      return true;
    } catch {
      setLifecycleStatus("Failed to send message");
      failCurrentAttempt();
      return false;
    }
  }, [isCompacting, patchSessionCache, viewerStatus]);

  const sendSessionInputRef = React.useRef(sendSessionInput);
  React.useEffect(() => { sendSessionInputRef.current = sendSessionInput; });
  React.useEffect(() => () => {
    for (const item of pendingHydrationInputsRef.current) item.resolve(false);
    pendingHydrationInputsRef.current = [];
  }, []);

  // Flush input queued during hydration once the session goes live. Entries
  // for a session the user has since switched away from are dropped.
  React.useEffect(() => {
    if (!lifecycle.isLive) return;
    const pending = pendingHydrationInputsRef.current;
    if (pending.length === 0) return;
    pendingHydrationInputsRef.current = [];
    const activeId = lifecycleRefs.activeSessionId.current;
    void (async () => {
      for (const item of pending) {
        if (item.sessionId !== activeId) {
          item.resolve(false);
          continue;
        }
        try {
          item.resolve((await sendSessionInputRef.current(item.message)) === true);
        } catch {
          item.resolve(false);
        }
      }
    })();
  }, [lifecycle.isLive, lifecycleRefs]);

  return { sendSessionInput, requestOlderMessages };
}
