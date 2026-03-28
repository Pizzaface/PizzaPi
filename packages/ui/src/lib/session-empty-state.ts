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
