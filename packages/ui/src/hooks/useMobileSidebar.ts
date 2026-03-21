import * as React from "react";

export interface MobileSidebarState {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sidebarSwipeOffset: number;
  suppressOverlayClickRef: React.RefObject<boolean>;
  handleSidebarPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleSidebarPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleSidebarPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * Manages mobile sidebar open/close state with swipe-left-to-close gesture
 * and body overflow locking.
 */
export function useMobileSidebar(): MobileSidebarState {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Swipe-left-to-close for the mobile sidebar — gesture lives on the overlay
  // (the dim backdrop to the right of the sidebar) so it never conflicts with
  // interactions inside the sidebar itself.
  const sidebarSwipeRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    locked: boolean;
    isVertical: boolean;
    didSwipe: boolean;
  } | null>(null);
  const sidebarSwipeOffsetRef = React.useRef(0);
  const [sidebarSwipeOffset, setSidebarSwipeOffset] = React.useState(0);
  // Suppresses the click that fires immediately after a swipe pointerUp
  const suppressOverlayClickRef = React.useRef(false);

  const handleSidebarPointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    sidebarSwipeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      locked: false,
      isVertical: false,
      didSwipe: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleSidebarPointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = sidebarSwipeRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (!s.locked && !s.isVertical) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        s.isVertical = true;
        sidebarSwipeRef.current = null;
        return;
      }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        s.locked = true;
      }
    }
    if (s.isVertical || !s.locked) return;
    s.didSwipe = true;
    // Only allow leftward swipes (negative dx), with a tiny rightward overscroll
    const clamped = Math.min(8, dx);
    sidebarSwipeOffsetRef.current = clamped;
    setSidebarSwipeOffset(clamped);
    e.preventDefault();
  }, []);

  const handleSidebarPointerUp = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = sidebarSwipeRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const didSwipe = s.didSwipe;
    sidebarSwipeRef.current = null;
    const offset = sidebarSwipeOffsetRef.current;
    sidebarSwipeOffsetRef.current = 0;
    setSidebarSwipeOffset(0);
    if (didSwipe) {
      // Suppress the click that the browser fires right after pointerUp
      suppressOverlayClickRef.current = true;
      requestAnimationFrame(() => { suppressOverlayClickRef.current = false; });
    }
    // Close if dragged more than 80 px to the left
    if (offset < -80) {
      setSidebarOpen(false);
    }
  }, []);

  // Prevent the underlying content from scrolling when the mobile sidebar is open.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    if (sidebarOpen) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarSwipeOffset,
    suppressOverlayClickRef,
    handleSidebarPointerDown,
    handleSidebarPointerMove,
    handleSidebarPointerUp,
  };
}
