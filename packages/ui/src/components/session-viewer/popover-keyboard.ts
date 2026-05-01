import * as React from "react";

export type PopoverArrowKey = "ArrowDown" | "ArrowUp";

export function getNextPopoverIndex(
  currentIndex: number,
  totalItems: number,
  key: string,
): number | null {
  if (totalItems <= 0) return null;
  if (key === "ArrowDown") {
    return currentIndex >= 0 && currentIndex < totalItems - 1 ? currentIndex + 1 : 0;
  }
  if (key === "ArrowUp") {
    return currentIndex > 0 ? currentIndex - 1 : totalItems - 1;
  }
  return null;
}

export interface DocumentPopoverKeyboardNavigationOptions {
  open: boolean;
  totalItems: number;
  highlightedIndex: number;
  setHighlightedIndex: (index: number) => void;
  popoverSelector: string;
  ignoreTargetSelector?: string;
}

function getSelectedPopoverOption(popover: ParentNode): HTMLElement | null {
  return popover.querySelector<HTMLElement>(
    "[data-selected='true'], [aria-selected='true'], [cmdk-item][data-selected='true']",
  );
}

export function useDocumentPopoverKeyboardNavigation({
  open,
  totalItems,
  highlightedIndex,
  setHighlightedIndex,
  popoverSelector,
  ignoreTargetSelector,
}: DocumentPopoverKeyboardNavigationOptions) {
  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

      const target = event.target instanceof Element ? event.target : null;
      if (target && ignoreTargetSelector && target.closest(ignoreTargetSelector)) return;

      const nextIndex = getNextPopoverIndex(highlightedIndex, totalItems, event.key);
      if (nextIndex === null) return;

      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex(nextIndex);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, totalItems, highlightedIndex, setHighlightedIndex, ignoreTargetSelector]);

  React.useEffect(() => {
    if (!open || highlightedIndex < 0) return;

    const frame = requestAnimationFrame(() => {
      const popover = document.querySelector(popoverSelector);
      const selected = popover ? getSelectedPopoverOption(popover) : null;
      selected?.scrollIntoView({ block: "nearest" });
    });

    return () => cancelAnimationFrame(frame);
  }, [open, highlightedIndex, popoverSelector]);
}
