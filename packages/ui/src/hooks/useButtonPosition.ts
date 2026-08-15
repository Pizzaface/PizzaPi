import * as React from "react";

export type ButtonSlot =
  | "top" // the session header toolbar (default)
  | "left-top" | "left-middle" | "left-bottom"
  | "center-top" | "center-bottom"
  | "right-top" | "right-middle" | "right-bottom";

/** Dynamic ID for a runner service panel button (e.g. "service:godmother-panel"). */
export type ServiceButtonId = `service:${string}`;

/** IDs for each draggable toolbar button in the SessionViewer. */
export type ToolbarButtonId =
  | "effort"
  | "plan"
  | "tokens"
  | "terminal"
  | "files"
  | "git"
  | "triggers"
  | "analyzer"
  | "export"
  | "duplicate"
  | "delete"
  | ServiceButtonId;

const ALL_BUTTON_IDS: readonly ToolbarButtonId[] = [
  "effort", "plan", "tokens",
  "terminal", "files", "git", "triggers", "analyzer",
  "export", "duplicate", "delete",
];

const STORAGE_KEY = "pp-toolbar-button-positions";

const VALID_SLOTS = new Set<string>([
  "top",
  "left-top", "left-middle", "left-bottom",
  "center-top", "center-bottom",
  "right-top", "right-middle", "right-bottom",
]);

function migrateSlot(v: unknown): ButtonSlot {
  if (v === "left") return "left-middle";
  if (v === "right") return "right-middle";
  if (typeof v === "string" && VALID_SLOTS.has(v)) return v as ButtonSlot;
  return "top";
}

function loadPositions(): Record<ToolbarButtonId, ButtonSlot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const result = {} as Record<ToolbarButtonId, ButtonSlot>;
        for (const id of ALL_BUTTON_IDS) {
          result[id] = migrateSlot(parsed[id]);
        }
        // Dynamic service panel buttons: keep any stored "service:*" entries.
        for (const key of Object.keys(parsed)) {
          if (key.startsWith("service:")) {
            result[key as ServiceButtonId] = migrateSlot(parsed[key]);
          }
        }
        return result;
      }
    }
  } catch {}
  // Default: everything at top
  const def = {} as Record<ToolbarButtonId, ButtonSlot>;
  for (const id of ALL_BUTTON_IDS) def[id] = "top";
  return def;
}

function savePositions(positions: Record<ToolbarButtonId, ButtonSlot>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(positions)); } catch {}
}

export interface ButtonPositionState {
  /** Current position of each button. */
  positions: Record<ToolbarButtonId, ButtonSlot>;
  /** Set a single button's position. */
  setButtonPosition: (id: ToolbarButtonId, slot: ButtonSlot) => void;
  /** Button IDs currently occupying each slot. */
  slots: Record<ButtonSlot, ToolbarButtonId[]>;
}

export function useButtonPosition(): ButtonPositionState {
  const [positions, setPositions] = React.useState<Record<ToolbarButtonId, ButtonSlot>>(loadPositions);

  const setButtonPosition = React.useCallback((id: ToolbarButtonId, slot: ButtonSlot) => {
    setPositions((prev) => {
      const next = { ...prev, [id]: slot };
      savePositions(next);
      return next;
    });
  }, []);

  const slots = React.useMemo(() => {
    const slots: Record<ButtonSlot, ToolbarButtonId[]> = {
      top: [],
      "left-top": [], "left-middle": [], "left-bottom": [],
      "center-top": [], "center-bottom": [],
      "right-top": [], "right-middle": [], "right-bottom": [],
    };
    for (const id of Object.keys(positions) as ToolbarButtonId[]) {
      slots[positions[id]].push(id);
    }
    return slots;
  }, [positions]);

  return { positions, setButtonPosition, slots };
}
