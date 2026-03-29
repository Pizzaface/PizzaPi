import * as React from "react";
import {
  PromptInputSubmit,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { getComposerSubmitMode } from "./composer-submit-state";

// ── ComposerSubmitButton ──────────────────────────────────────────────────────

interface ComposerSubmitButtonProps {
  sessionId: string | null;
  input: string;
  agentActive?: boolean;
  onExec?: (payload: unknown) => boolean | void;
  isTouchDevice?: boolean;
}

/**
 * The send / stop button rendered at the bottom-right of the composer.
 *
 * Delegates mode selection to `getComposerSubmitMode` so the logic is tested
 * independently. Renders nothing when the mode is "hidden".
 */
export function ComposerSubmitButton({
  sessionId,
  input,
  agentActive,
  onExec,
  isTouchDevice,
}: ComposerSubmitButtonProps) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;
  const hasDraft = input.trim().length > 0 || hasAttachments;
  const submitMode = getComposerSubmitMode({
    isTouchDevice: Boolean(isTouchDevice),
    agentActive: Boolean(agentActive),
    hasDraft,
    canAbort: Boolean(agentActive && onExec),
  });

  if (submitMode === "hidden") return null;

  const showStopMode = submitMode === "stop";

  return (
    <PromptInputSubmit
      status={showStopMode ? "streaming" : "ready"}
      onStop={
        showStopMode && onExec
          ? () => {
              onExec({
                type: "exec",
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                command: "abort",
              });
            }
          : undefined
      }
      disabled={!sessionId || (!showStopMode && !hasDraft)}
    />
  );
}
