import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Window } from "happy-dom";
import { renderHook, act } from "@testing-library/react";

const win = new Window({ url: "http://localhost/" });
(globalThis as unknown as Record<string, unknown>).window = win;
(globalThis as unknown as Record<string, unknown>).document = win.document;
(globalThis as unknown as Record<string, unknown>).navigator = win.navigator;
(globalThis as unknown as Record<string, unknown>).localStorage = win.localStorage;
(globalThis as unknown as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as unknown as Record<string, unknown>).Element = win.Element;
(globalThis as unknown as Record<string, unknown>).Node = win.Node;
(globalThis as unknown as Record<string, unknown>).MutationObserver = win.MutationObserver;
(globalThis as unknown as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);

afterAll(() => {
  // Cleanup globals to avoid cross-test contamination
  (globalThis as unknown as Record<string, unknown>).window = undefined;
  (globalThis as unknown as Record<string, unknown>).document = undefined;
});

const STORAGE_KEY = "pp-toolbar-button-positions";
const { useButtonPosition } = await import("./useButtonPosition");

describe("useButtonPosition", () => {
  beforeEach(() => {
    win.localStorage.clear();
  });

  const ALL_SLOTS = [
    "top",
    "left-top", "left-middle", "left-bottom",
    "center-top", "center-bottom",
    "right-top", "right-middle", "right-bottom",
  ] as const;

  test("defaults every button to the top slot", () => {
    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.slots.top).toHaveLength(10);
    for (const slot of ALL_SLOTS) {
      if (slot !== "top") {
        expect(result.current.slots[slot]).toHaveLength(0);
      }
    }
  });

  test("slots record contains all 9 keys", () => {
    const { result } = renderHook(() => useButtonPosition());
    expect(Object.keys(result.current.slots)).toHaveLength(9);
    expect(result.current.slots.top).toHaveLength(10);
    for (const slot of ALL_SLOTS) {
      if (slot === "top") continue;
      expect(result.current.slots[slot]).toEqual([]);
    }
  });

  test("moves a button to another slot", () => {
    const { result } = renderHook(() => useButtonPosition());
    act(() => result.current.setButtonPosition("terminal", "left-middle"));
    expect(result.current.positions.terminal).toBe("left-middle");
    expect(result.current.slots["left-middle"]).toContain("terminal");
    expect(result.current.slots.top).not.toContain("terminal");
  });

  test("persists positions to localStorage", () => {
    const { result } = renderHook(() => useButtonPosition());
    act(() => {
      result.current.setButtonPosition("files", "right-middle");
      result.current.setButtonPosition("git", "left-middle");
    });

    const raw = win.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.files).toBe("right-middle");
    expect(saved.git).toBe("left-middle");
  });

  test("loads previously saved positions", () => {
    win.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        effort: "top",
        plan: "left-middle",
        tokens: "right-middle",
        terminal: "top",
        files: "left-bottom",
        git: "right-bottom",
        triggers: "top",
        export: "center-top",
        duplicate: "center-bottom",
        delete: "top",
      }),
    );

    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.positions.plan).toBe("left-middle");
    expect(result.current.positions.tokens).toBe("right-middle");
    expect(result.current.positions["export"]).toBe("center-top");
    expect(result.current.positions["duplicate"]).toBe("center-bottom");
    expect(result.current.slots["left-middle"]).toContain("plan");
    expect(result.current.slots["right-middle"]).toContain("tokens");
  });

  test("ignores invalid saved slots and falls back to top", () => {
    win.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: "center", files: "left-middle" }),
    );

    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.positions.terminal).toBe("top");
    expect(result.current.positions.files).toBe("left-middle");
  });

  test("migrates legacy left and right slots on load", () => {
    win.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        effort: "top",
        plan: "left",
        tokens: "right",
        terminal: "top",
        files: "left",
        git: "right",
        triggers: "top",
        export: "left",
        duplicate: "right",
        delete: "top",
      }),
    );

    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.positions.plan).toBe("left-middle");
    expect(result.current.positions.tokens).toBe("right-middle");
    expect(result.current.slots["left-middle"]).toContain("plan");
    expect(result.current.slots["right-middle"]).toContain("tokens");
    expect(result.current.slots.top).toHaveLength(4);
    expect(result.current.slots["left-middle"]).toHaveLength(3);
    expect(result.current.slots["right-middle"]).toHaveLength(3);
  });

  test("tracks dynamic service panel button ids", () => {
    const { result, unmount } = renderHook(() => useButtonPosition());
    act(() => result.current.setButtonPosition("service:godmother-panel", "right-top"));
    expect(result.current.positions["service:godmother-panel"]).toBe("right-top");
    expect(result.current.slots["right-top"]).toContain("service:godmother-panel");

    // Round-trips through localStorage on remount
    unmount();
    const { result: result2 } = renderHook(() => useButtonPosition());
    expect(result2.current.positions["service:godmother-panel"]).toBe("right-top");
    expect(result2.current.slots["right-top"]).toContain("service:godmother-panel");
    // Untracked service ids default to header (undefined → treated as "top")
    expect(result2.current.positions["service:unknown"]).toBeUndefined();
  });

  test("drops invalid stored service slot values back to top", () => {
    win.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "service:tunnel": "bogus", "service:nightshift": "left" }),
    );
    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.positions["service:tunnel"]).toBe("top");
    expect(result.current.positions["service:nightshift"]).toBe("left-middle");
  });

  test("round-trips a new zone value through save and load", () => {
    const { result, unmount } = renderHook(() => useButtonPosition());
    act(() => result.current.setButtonPosition("files", "left-bottom"));
    expect(result.current.positions.files).toBe("left-bottom");
    expect(result.current.slots["left-bottom"]).toContain("files");

    unmount();
    const { result: result2 } = renderHook(() => useButtonPosition());
    expect(result2.current.positions.files).toBe("left-bottom");
    expect(result2.current.slots["left-bottom"]).toContain("files");
    expect(result2.current.slots.top).not.toContain("files");
  });
});
