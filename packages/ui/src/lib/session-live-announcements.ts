/**
 * Decides what (if anything) an assertive ARIA live region should announce
 * when session connectivity status or agent-active state changes. Keeps the
 * decision logic out of SessionViewer.tsx so it's unit-testable without
 * mounting the full component tree.
 */

const NOMINAL_STATUSES = new Set(["Connected", "Idle", "Connecting…"]);

export function computeLiveAnnouncement(
  prevStatus: string | undefined,
  nextStatus: string | undefined,
  prevAgentActive: boolean,
  nextAgentActive: boolean,
): string | null {
  if (nextStatus !== prevStatus) {
    if (nextStatus === "Connected" && prevStatus !== undefined && prevStatus !== "Connecting…") {
      return "Session reconnected";
    }
    if (nextStatus && !NOMINAL_STATUSES.has(nextStatus)) {
      // Covers disconnects, restarts, and surfaced error reasons — the
      // status string itself is the user-facing message in all these cases.
      return nextStatus;
    }
  }

  if (nextAgentActive !== prevAgentActive) {
    return nextAgentActive ? "Agent started" : "Agent stopped";
  }

  return null;
}
