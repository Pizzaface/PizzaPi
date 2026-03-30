/**
 * SigilHoverCard — touch-friendly hover card wrapper for sigil pills.
 *
 * On desktop: standard hover-to-open (400ms delay), hover-off-to-close.
 * On mobile/touch: tap the pill to toggle open, tap outside to close.
 *
 * Uses Radix HoverCard in controlled mode so both interaction models coexist.
 * The hover events are handled natively by Radix; touch is handled explicitly
 * via onTouchEnd + onClick coordination.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

interface SigilHoverCardProps {
  /** The pill element rendered as the trigger. */
  pill: ReactNode;
  /** Content rendered inside the hover card popover. */
  children: ReactNode;
}

export function SigilHoverCard({ pill, children }: SigilHoverCardProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Track whether the last interaction was a touch so we can suppress
  // the ghost click that mobile browsers fire after touchend.
  const wasTouchRef = useRef(false);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    wasTouchRef.current = true;
    e.preventDefault(); // prevent the ghost click
    setOpen((prev) => !prev);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // If this click was synthesized from a touch, ignore — touchEnd handled it
    if (wasTouchRef.current) {
      wasTouchRef.current = false;
      return;
    }
    // On desktop, clicking a link pill should navigate, not toggle the card.
    const target = e.target as HTMLElement;
    if (target.closest("a[href]")) return;
    setOpen((prev) => !prev);
  }, []);

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={400} closeDelay={200}>
      <HoverCardTrigger asChild>
        <span
          ref={triggerRef}
          onTouchEnd={handleTouchEnd}
          onClick={handleClick}
          className="inline"
        >
          {pill}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        className="w-auto min-w-[180px] max-w-[280px] p-3"
        // Close when tapping outside on mobile
        onPointerDownOutside={() => setOpen(false)}
      >
        {children}
      </HoverCardContent>
    </HoverCard>
  );
}
