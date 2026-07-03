import * as React from "react";
import { cn } from "@/lib/utils";
import type { ToolbarButtonId } from "@/hooks/useButtonPosition";

export interface DraggableToolbarButtonProps {
  buttonId: ToolbarButtonId;
  children: React.ReactNode;
  /** Called when the user click-and-holds to start dragging. */
  onDragStart?: (buttonId: ToolbarButtonId) => void;
  className?: string;
}

const HOLD_DURATION_MS = 300;
const MOVE_THRESHOLD_PX = 5;

/**
 * Wraps a toolbar button. Click-and-hold (300ms) initiates a drag.
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

  const clearHold = React.useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!onDragStart) return;
      if (e.button !== 0) return;

      dragStarted.current = false;
      pointerStart.current = { x: e.clientX, y: e.clientY };

      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        if (pointerStart.current) {
          dragStarted.current = true;
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
      // Moved too much — cancel the hold
      clearHold();
    }
  }, [clearHold]);

  const handlePointerUp = React.useCallback(() => {
    clearHold();
    pointerStart.current = null;
    // If drag started, prevent the click event from firing on the child button
    if (dragStarted.current) {
      dragStarted.current = false;
      // Prevent the subsequent click event
      return true;
    }
    return false;
  }, [clearHold]);

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
      className={cn("relative", className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClickCapture={handleClickCapture}
      style={{ touchAction: "none" }}
    >
      {children}
    </div>
  );
}
