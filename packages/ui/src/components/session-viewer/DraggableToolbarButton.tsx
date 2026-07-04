import * as React from "react";
import { cn } from "@/lib/utils";
import { dragArmHaptic } from "@/lib/haptics";
import type { ToolbarButtonId } from "@/hooks/useButtonPosition";

export interface DraggableToolbarButtonProps {
  buttonId: ToolbarButtonId;
  children: React.ReactNode;
  /** Called when the user click-and-holds to start dragging. */
  onDragStart?: (buttonId: ToolbarButtonId) => void;
  className?: string;
}

const HOLD_DURATION_MS = 200;
const MOVE_THRESHOLD_PX = 8;

/**
 * Wraps a toolbar button. Click-and-hold (200ms) initiates a drag.
 * A normal click passes through to the child button.
 */
export function DraggableToolbarButton({
  buttonId,
  children,
  onDragStart,
  className,
}: DraggableToolbarButtonProps) {
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = React.useRef<{ x: number; y: number } | null>(null);
  const dragStarted = React.useRef(false);
  const [arming, setArming] = React.useState(false);
  const [armed, setArmed] = React.useState(false);

  const clearHold = React.useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const resetFeedback = React.useCallback(() => {
    setArming(false);
    setArmed(false);
  }, []);

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!onDragStart) return;
      if (e.button !== 0) return;

      dragStarted.current = false;
      setArmed(false);
      setArming(true);
      pointerStart.current = { x: e.clientX, y: e.clientY };

      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        if (pointerStart.current) {
          dragStarted.current = true;
          setArming(false);
          setArmed(true);
          void dragArmHaptic();
          onDragStart(buttonId);
        }
      }, HOLD_DURATION_MS);
    },
    [buttonId, onDragStart],
  );

  const handlePointerMove = React.useCallback((e: React.PointerEvent) => {
    if (!pointerStart.current || dragStarted.current) return;
    const dx = Math.abs(e.clientX - pointerStart.current.x);
    const dy = Math.abs(e.clientY - pointerStart.current.y);
    if (dx > MOVE_THRESHOLD_PX || dy > MOVE_THRESHOLD_PX) {
      // Moved too much — cancel the hold and reset arming feedback
      clearHold();
      resetFeedback();
    }
  }, [clearHold, resetFeedback]);

  const handlePointerUp = React.useCallback(() => {
    clearHold();
    pointerStart.current = null;
    resetFeedback();
    if (dragStarted.current) {
      // Defer the reset so handleClickCapture can still suppress the
      // click event that fires right after this pointerup.
      setTimeout(() => { dragStarted.current = false; }, 0);
    }
  }, [clearHold, resetFeedback]);

  // The drop is handled by document-level listeners in App, so when the
  // pointer is released away from this element our own onPointerUp never
  // fires. Reset the armed visuals from the document instead.
  React.useEffect(() => {
    if (!armed) return;
    const reset = () => {
      resetFeedback();
      pointerStart.current = null;
      setTimeout(() => { dragStarted.current = false; }, 0);
    };
    document.addEventListener("pointerup", reset);
    document.addEventListener("pointercancel", reset);
    return () => {
      document.removeEventListener("pointerup", reset);
      document.removeEventListener("pointercancel", reset);
    };
  }, [armed, resetFeedback]);

  // Prevent click when drag was started
  const handleClickCapture = React.useCallback((e: React.MouseEvent) => {
    if (dragStarted.current) {
      e.stopPropagation();
      e.preventDefault();
      dragStarted.current = false;
    }
  }, []);

  return (
    <div
      className={cn(
        "relative transition-transform",
        (arming || armed) && "scale-110 ring-2 ring-blue-500/60 rounded-md",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClickCapture={handleClickCapture}
      style={{
        touchAction: "none",
        transitionDuration: arming || armed ? `${HOLD_DURATION_MS}ms` : undefined,
      }}
    >
      {children}
    </div>
  );
}
