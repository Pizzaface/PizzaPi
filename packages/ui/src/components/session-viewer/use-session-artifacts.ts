import * as React from "react";
import type { RelayMessage } from "@/components/session-viewer/types";
import { detectArtifact, type ArtifactKind } from "@/components/session-viewer/artifact-detection";
import type { ResolvedModeUi } from "@pizzapi/protocol";

/** An artifact discovered in the session transcript. */
export interface SessionArtifact {
  /** Absolute or workspace-relative file path written by the tool call. */
  path: string;
  /** How the artifact should be previewed / downloaded. */
  kind: ArtifactKind;
  /** Tool call ID this artifact came from, for navigation if needed. */
  toolCallId?: string;
  /** Message timestamp, if available. */
  timestamp?: number;
}

/**
 * Scan session messages for tool calls that produced deliverables.
 *
 * Reuses the same detection rules as inline ArtifactCard rendering, so the
 * panel and the transcript always agree on what counts as an artifact.
 * Duplicates by path collapse to the latest timestamp.
 */
export function useSessionArtifacts(
  messages: RelayMessage[],
  modeUi: ResolvedModeUi | null | undefined,
): SessionArtifact[] {
  return React.useMemo(() => {
    if (!modeUi?.artifacts) return [];

    const latestByPath = new Map<string, SessionArtifact>();

    for (const message of messages) {
      if (!message.toolName || message.toolInput === undefined) continue;
      // Only finished writes produce a readable artifact.
      if (message.isError || message.isStreamingPartial) continue;

      const detected = detectArtifact(message.toolName, message.toolInput, modeUi);
      if (!detected) continue;

      const existing = latestByPath.get(detected.path);
      const timestamp = message.timestamp ?? existing?.timestamp;
      if (!existing || (timestamp ?? 0) >= (existing.timestamp ?? 0)) {
        latestByPath.set(detected.path, {
          path: detected.path,
          kind: detected.kind,
          toolCallId: message.toolCallId,
          timestamp,
        });
      }
    }

    return Array.from(latestByPath.values()).sort((a, b) => {
      const aTs = a.timestamp ?? Number.POSITIVE_INFINITY;
      const bTs = b.timestamp ?? Number.POSITIVE_INFINITY;
      if (aTs !== bTs) return aTs - bTs;
      return a.path.localeCompare(b.path);
    });
  }, [messages, modeUi]);
}
