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

const SIDEBAR_WIDTH = 288; // w-72

/**
 * Manages mobile sidebar open/close state with swipe-left-to-close (on the
 * overlay) and swipe-right-from-left-edge-to-open gestures, plus body
 * overflow locking.
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
    const clamped = Math.max(-SIDEBAR_WIDTH, Math.min(8, dx));
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

  // Swipe-right-from-left-edge to open. Document-level listeners with a lazy
  // claim: taps and vertical scrolls in the zone pass through untouched; we
  // only own the gesture once a rightward horizontal drag locks. The Android
  // system back gesture owns the outermost edge — when it wins we just get a
  // pointercancel and reset. The 40px zone extends inward past it so swipes
  // starting slightly inside the edge still open the sidebar.
  const sidebarOpenRef = React.useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  React.useEffect(() => {
    const EDGE_ZONE = 64;
    let s: { pointerId: number; startX: number; startY: number; locked: boolean } | null = null;

    const reset = () => {
      s = null;
      sidebarSwipeOffsetRef.current = 0;
      setSidebarSwipeOffset(0);
    };

    const onDown = (e: PointerEvent) => {
      if (sidebarOpenRef.current || e.button !== 0 || e.clientX > EDGE_ZONE) return;
      if (window.matchMedia("(min-width: 768px)").matches) return; // desktop: sidebar is static
      s = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, locked: false };
    };

    const onMove = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.pointerId) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (!s.locked) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { s = null; return; } // vertical → scroll wins
        if (dx > 8 && dx > Math.abs(dy)) s.locked = true;
        else return;
      }
      // Drag the sidebar out from its closed position (-SIDEBAR_WIDTH), clamped
      // at -1 so the inline transform stays active for the whole drag.
      const clamped = Math.max(-SIDEBAR_WIDTH, Math.min(-1, -SIDEBAR_WIDTH + dx));
      sidebarSwipeOffsetRef.current = clamped;
      setSidebarSwipeOffset(clamped);
    };

    // Block native scrolling only while we own a locked horizontal drag
    const onTouchMove = (e: TouchEvent) => {
      if (s?.locked) e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.pointerId) return;
      const locked = s.locked;
      const offset = sidebarSwipeOffsetRef.current;
      reset();
      if (!locked) return;
      // Swallow the click that fires right after the drag
      const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
      document.addEventListener("click", swallow, { capture: true, once: true });
      requestAnimationFrame(() => document.removeEventListener("click", swallow, { capture: true }));
      // Open if dragged more than 80 px out from the edge
      if (offset > -SIDEBAR_WIDTH + 80) setSidebarOpen(true);
    };

    const onCancel = (e: PointerEvent) => {
      if (s && e.pointerId === s.pointerId) reset();
    };

    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
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
