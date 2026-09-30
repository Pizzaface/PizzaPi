import * as React from "react";
import type { useButtonPosition, ToolbarButtonId, ButtonSlot } from "@/hooks/useButtonPosition";
import { resolveButtonDragZone } from "./panel-zones";

/**
 * Drag-to-dock for toolbar buttons: while a button is being dragged, track
 * the 3x3 drop zone under the pointer (document-level listeners, since the
 * drag starts from a long-press timer and can't use pointer capture) and
 * commit the new slot on pointerup.
 */
export function useButtonDrag(
  buttonPositions: ReturnType<typeof useButtonPosition>,
  terminalColumnRef: React.RefObject<HTMLDivElement | null>,
) {
  // ── Button drag state ───────────────────────────────────────────────────
  const [draggingButton, setDraggingButton] = React.useState<ToolbarButtonId | null>(null);
  const [buttonDragZone, setButtonDragZone] = React.useState<ButtonSlot | null>(null);
  const draggingButtonRef = React.useRef<ToolbarButtonId | null>(null);
  const buttonDragZoneRef = React.useRef<ButtonSlot | null>(null);

  const handleButtonDragStart = React.useCallback((buttonId: ToolbarButtonId) => {
    draggingButtonRef.current = buttonId;
    buttonDragZoneRef.current = null;
    setDraggingButton(buttonId);
    setButtonDragZone(null);
  }, []);

  // Document-level listeners for button drag (can't use pointer capture from timer)
  React.useEffect(() => {
    if (!draggingButton) return;

    const onMove = (e: PointerEvent) => {
      if (!terminalColumnRef.current) return;
      const rect = terminalColumnRef.current.getBoundingClientRect();
      const zone = resolveButtonDragZone(e.clientX, e.clientY, rect);
      buttonDragZoneRef.current = zone;
      setButtonDragZone(zone);
    };

    const onUp = () => {
      const btn = draggingButtonRef.current;
      const zone = buttonDragZoneRef.current;
      if (btn && zone) {
        buttonPositions.setButtonPosition(btn, zone);
      }
      draggingButtonRef.current = null;
      buttonDragZoneRef.current = null;
      setDraggingButton(null);
      setButtonDragZone(null);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [draggingButton, buttonPositions, terminalColumnRef]);

  return { draggingButton, buttonDragZone, handleButtonDragStart };
}
