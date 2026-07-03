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

  test("defaults every button to the top slot", () => {
    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.slots.top).toHaveLength(10);
    expect(result.current.slots.left).toHaveLength(0);
    expect(result.current.slots.right).toHaveLength(0);
  });

  test("moves a button to another slot", () => {
    const { result } = renderHook(() => useButtonPosition());
    act(() => result.current.setButtonPosition("terminal", "left"));
    expect(result.current.positions.terminal).toBe("left");
    expect(result.current.slots.left).toContain("terminal");
    expect(result.current.slots.top).not.toContain("terminal");
  });

  test("persists positions to localStorage", () => {
    const { result } = renderHook(() => useButtonPosition());
    act(() => {
      result.current.setButtonPosition("files", "right");
      result.current.setButtonPosition("git", "left");
    });

    const raw = win.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.files).toBe("right");
    expect(saved.git).toBe("left");
  });

  test("loads previously saved positions", () => {
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
    expect(result.current.positions.plan).toBe("left");
    expect(result.current.positions.tokens).toBe("right");
    expect(result.current.slots.left).toContain("plan");
    expect(result.current.slots.right).toContain("tokens");
  });

  test("ignores invalid saved slots and falls back to top", () => {
    win.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: "center", files: "left" }),
    );

    const { result } = renderHook(() => useButtonPosition());
    expect(result.current.positions.terminal).toBe("top");
    expect(result.current.positions.files).toBe("left");
  });
});
