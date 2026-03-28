export interface SessionEmptyStateUi {
  title: string;
  description: string;
  shouldSpinLogo: boolean;
}

/**
 * Returns true when the viewer is actively hydrating/loading a session.
 */
export function isSessionHydrating(viewerStatus: string | null | undefined): boolean {
  if (typeof viewerStatus !== "string") return false;
  const status = viewerStatus.trim().toLowerCase();
  if (!status) return false;
  return status.startsWith("connecting") || status.startsWith("loading session");
}

/**
 * Returns true when the transcript should be shown to the user.
 *
 * Hydrating sessions intentionally hide cached transcript content so a fast
 * session switch never flashes the previous session's messages while waiting
 * for the fresh snapshot.
 */
export function shouldShowSessionTranscript(
  sessionId: string | null | undefined,
  viewerStatus: string | null | undefined,
  hasVisibleMessages: boolean,
): boolean {
  return !!sessionId && !isSessionHydrating(viewerStatus) && hasVisibleMessages;
}

/**
 * Copy + animation state for session-specific empty states.
 */
export function getSessionEmptyStateUi(viewerStatus: string | null | undefined): SessionEmptyStateUi {
  if (isSessionHydrating(viewerStatus)) {
    return {
      title: "Loading session",
      description: "Fetching conversation data…",
      shouldSpinLogo: true,
    };
  }

  return {
    title: "Waiting for session events",
    description: "Messages will appear here in real time.",
    shouldSpinLogo: false,
  };
}
