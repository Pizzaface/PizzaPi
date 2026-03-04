export type ComposerSubmitMode = "hidden" | "send" | "stop";

interface ComposerSubmitStateInput {
  isTouchDevice: boolean;
  agentActive: boolean;
  hasDraft: boolean;
  canAbort: boolean;
}

/**
 * Decide which composer submit control should be shown.
 *
 * - Desktop keeps a visible send button at all times and swaps to stop while streaming.
 * - Mobile hides send until the user has a draft. During streaming, stop is shown
 *   unless the user is composing a follow-up, in which case send is shown so they
 *   can queue the next message.
 */
export function getComposerSubmitMode({
  isTouchDevice,
  agentActive,
  hasDraft,
  canAbort,
}: ComposerSubmitStateInput): ComposerSubmitMode {
  if (agentActive && canAbort) {
    if (!isTouchDevice) return "stop";
    return hasDraft ? "send" : "stop";
  }

  if (isTouchDevice && !hasDraft) {
    return "hidden";
  }

  return "send";
}
