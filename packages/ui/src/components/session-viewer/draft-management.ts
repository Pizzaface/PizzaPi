import * as React from "react";

export interface DraftManagementResult {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  deliveryMode: "steer" | "followUp";
  setDeliveryMode: React.Dispatch<React.SetStateAction<"steer" | "followUp">>;
  /** Persist the current draft for the given session (call before switching). */
  draftsRef: React.MutableRefObject<Map<string, string>>;
  deliveryModeRef: React.MutableRefObject<Map<string, "steer" | "followUp">>;
}

/**
 * Manages per-session draft text and delivery-mode state.
 *
 * On every sessionId change:
 *  1. Saves the current input + delivery mode under the previous sessionId.
 *  2. Restores the saved values for the new sessionId (or clears them).
 *
 * The session-switch side-effects (resetting command picker, @-mention, composer
 * error) are intentionally left to the caller so this hook stays self-contained.
 *
 * The react-hooks exhaustive-deps rule is disabled for the effect intentionally —
 * `input` and `deliveryMode` are read at transition time only (snapshot semantics),
 * not listed as reactive dependencies.
 */
export function useDraftManagement(sessionId: string | null): DraftManagementResult {
  const [input, setInput] = React.useState("");
  const [deliveryMode, setDeliveryMode] = React.useState<"steer" | "followUp">("followUp");
  const draftsRef = React.useRef<Map<string, string>>(new Map());
  const deliveryModeRef = React.useRef<Map<string, "steer" | "followUp">>(new Map());
  const prevSessionIdRef = React.useRef<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally reading `input` and `deliveryMode` at transition time only
  React.useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId) {
      draftsRef.current.set(prevId, input);
      deliveryModeRef.current.set(prevId, deliveryMode);
    }
    if (sessionId) {
      setInput(draftsRef.current.get(sessionId) ?? "");
      setDeliveryMode(deliveryModeRef.current.get(sessionId) ?? "followUp");
    } else {
      setInput("");
      setDeliveryMode("followUp");
    }
    prevSessionIdRef.current = sessionId ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { input, setInput, deliveryMode, setDeliveryMode, draftsRef, deliveryModeRef };
}
