/**
 * Decides what (if anything) an ARIA live region should announce when
 * session connectivity or agent-active state changes. Keeps the decision
 * logic out of SessionViewer.tsx so it's unit-testable without mounting the
 * full component tree.
 *
 * `disconnected` must come from the lifecycle's actual connectivity phase
 * (e.g. `phase === "reconnecting" || phase === "error"` in
 * use-session-lifecycle.ts), NOT from comparing status strings. The
 * `viewerStatus` string is also used for a lot of non-connectivity status
 * bar messages (toasts like "Copied", "Model set", "Compacting…", hydration
 * progress, etc.) that must never be mistaken for a disconnect/reconnect.
 */

export interface LiveAnnouncementState {
  /** The current status-bar text (used verbatim for disconnect/error wording). */
  status: string | undefined;
  /** True only while the lifecycle phase represents a real connectivity loss. */
  disconnected: boolean;
  /** Whether the agent is currently processing a turn. */
  agentActive: boolean;
  /**
   * True when `status` is a manual toast override (e.g. "Copied", "Model
   * set") rather than a lifecycle-owned disconnect/error reason. While still
   * disconnected, an override status change must NOT be announced as a new
   * disconnect reason.
   */
  statusIsOverride?: boolean;
}

export interface LiveAnnouncements {
  /** Urgent text for an assertive live region: disconnects and errors only. */
  assertive: string | null;
  /** Routine text for a polite live region: agent start/stop. */
  polite: string | null;
}

export function computeLiveAnnouncements(
  prev: LiveAnnouncementState,
  next: LiveAnnouncementState,
): LiveAnnouncements {
  let assertive: string | null = null;

  if (next.disconnected !== prev.disconnected || next.status !== prev.status) {
    if (next.disconnected && !prev.disconnected) {
      // Just went offline — surface the reason text as-is (e.g. "Restarting
      // CLI…", "Disconnected", a surfaced provider error).
      assertive = next.status || "Disconnected";
    } else if (!next.disconnected && prev.disconnected) {
      assertive = "Session reconnected";
    } else if (
      next.disconnected &&
      prev.disconnected &&
      next.status !== prev.status &&
      !next.statusIsOverride
    ) {
      // Still offline, but the reason changed (e.g. a connect_error message
      // replaced the initial "Restarting CLI…"). A manual status override
      // (next.statusIsOverride, e.g. a "Copied"/"Model set" toast dispatched
      // while the phase happens to still be reconnecting/error) is never a
      // disconnect-reason change and must not be announced.
      assertive = next.status || null;
    }
  }

  let polite: string | null = null;
  if (next.agentActive !== prev.agentActive) {
    polite = next.agentActive ? "Agent started" : "Agent stopped";
  }

  return { assertive, polite };
}
