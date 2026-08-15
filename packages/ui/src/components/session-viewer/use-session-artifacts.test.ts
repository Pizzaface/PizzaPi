import { describe, test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { renderHook, cleanup } from "@testing-library/react";
import { useSessionArtifacts } from "./use-session-artifacts";
import type { RelayMessage } from "@/components/session-viewer/types";
import type { ResolvedModeUi } from "@pizzapi/protocol";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

afterEach(() => cleanup());

const modeUi: ResolvedModeUi = {
  artifacts: true,
  artifactExtensions: ["md", "csv", "png"],
} as ResolvedModeUi;

const disabledModeUi: ResolvedModeUi = { artifacts: false, artifactExtensions: [] } as ResolvedModeUi;

function makeToolMessage(
  toolName: string,
  toolInput: unknown,
  overrides: Partial<RelayMessage> = {},
): RelayMessage {
  return {
    key: `msg-${Math.random().toString(36).slice(2)}`,
    role: "tool",
    toolName,
    toolInput,
    ...overrides,
  };
}

describe("useSessionArtifacts", () => {
  test("returns empty when artifacts are disabled", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", { path: "/w/report.md" }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, disabledModeUi));
    expect(result.current).toEqual([]);
  });

  test("ignores non-write tools", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("bash", { command: "ls" }),
      makeToolMessage("read", { path: "/w/report.md" }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current).toEqual([]);
  });

  test("detects write_file and edit artifacts", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", { path: "/w/report.md" }),
      makeToolMessage("edit", { path: "/w/data.csv" }),
      makeToolMessage("write_file", { path: "/w/ignored.ts" }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current.map((a) => a.path)).toEqual(["/w/data.csv", "/w/report.md"]);
  });

  test("keeps the latest timestamp when a path is written twice", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", { path: "/w/report.md" }, { timestamp: 1000, key: "a" }),
      makeToolMessage("write_file", { path: "/w/report.md" }, { timestamp: 2000, key: "b" }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].timestamp).toBe(2000);
  });

  test("sorts by timestamp then path", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", { path: "/w/b.md" }, { timestamp: 2000 }),
      makeToolMessage("write_file", { path: "/w/a.md" }, { timestamp: 1000 }),
      makeToolMessage("write_file", { path: "/w/c.md" }, { timestamp: 2000 }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current.map((a) => a.path)).toEqual(["/w/a.md", "/w/b.md", "/w/c.md"]);
  });

  test("skips error and streaming-partial messages", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", { path: "/w/bad.md" }, { isError: true }),
      makeToolMessage("write_file", { path: "/w/partial.md" }, { isStreamingPartial: true }),
      makeToolMessage("write_file", { path: "/w/good.md" }),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current.map((a) => a.path)).toEqual(["/w/good.md"]);
  });

  test("toolInput as JSON string is parsed", () => {
    const messages: RelayMessage[] = [
      makeToolMessage("write_file", JSON.stringify({ path: "/w/string.md" }) as any),
    ];
    const { result } = renderHook(() => useSessionArtifacts(messages, modeUi));
    expect(result.current.map((a) => a.path)).toEqual(["/w/string.md"]);
  });
});
