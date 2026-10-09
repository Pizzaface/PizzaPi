import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { PLUGIN_COMMAND_MESSAGE_TYPE } from "@pizzapi/protocol";

import { getExportMessages, isVisibleMessage, useMessageProcessor } from "./message-processor";
import { exportToMarkdown } from "@/lib/export-markdown";
import type { RelayMessage } from "./types";

function textMessage(index: number): RelayMessage {
  return {
    key: `m-${index}`,
    role: "assistant",
    timestamp: index,
    content: [{ type: "text", text: `message ${index}` }],
  };
}

describe("useMessageProcessor", () => {
  test("limits transcript processing to the visible tail window", () => {
    const messages = Array.from({ length: 600 }, (_, index) => textMessage(index));

    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));

    expect(result.current.visibleMessages).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.visibleMessages[0]?.key.startsWith("m-550")).toBe(true);
    expect(result.current.visibleMessages.at(-1)?.key.startsWith("m-599")).toBe(true);
  });

  test("orders messages chronologically while preserving ties", () => {
    const sorted = getExportMessages([
      textMessage(2),
      { ...textMessage(1), key: "first-tie" },
      { ...textMessage(1), key: "second-tie" },
      { ...textMessage(3), timestamp: undefined },
    ]);
    expect(sorted.map((message) => message.key)).toEqual([
      "first-tie:assistant:0", "second-tie:assistant:0", "m-2:assistant:0", "m-3:assistant:0",
    ]);
  });

  test("provides grouped tool input to the SessionViewer export path", () => {
    const messages: RelayMessage[] = [
      { key: "assistant", role: "assistant", timestamp: 1, content: [
        { type: "toolCall", name: "bash", id: "call-1", arguments: { command: "echo grouped" } },
      ] },
      { key: "result", role: "toolResult", toolName: "bash", toolCallId: "call-1", timestamp: 2, content: "ok" },
    ];
    expect(exportToMarkdown(messages)).not.toContain("**Input:**");
    expect(exportToMarkdown(getExportMessages(messages))).toContain("**Input:**");
  });

  test("expands backward when a raw tail contains too few visible messages", () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({
      ...textMessage(index),
      content: index % 10 === 0 ? [{ type: "text", text: `message ${index}` }] : [],
    }));
    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));
    expect(result.current.visibleMessages).toHaveLength(50);
    expect(result.current.visibleMessages[0]?.key).toBe("m-100:assistant:0");
    expect(result.current.hasMore).toBe(true);
  });

  test("extends grouping lookbehind to include a tool call before the window", () => {
    const messages = Array.from({ length: 80 }, (_, index) => textMessage(index));
    messages[5] = {
      key: "call", role: "assistant", timestamp: 5,
      content: [{ type: "toolCall", name: "bash", id: "call-1", arguments: { command: "echo hi" } }],
    };
    messages[75] = { key: "result", role: "toolResult", toolName: "bash", toolCallId: "call-1", timestamp: 75, content: "done" };

    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));
    expect(result.current.visibleMessages.some((message) => message.key === "result")).toBe(false);
    expect(result.current.visibleMessages.find((message) => message.key === "pending-tool:call-1")?.toolInput)
      .toEqual({ command: "echo hi" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Equivalence harness
//
// The ground truth for "what should be visible" is the untouched, unwindowed
// pipeline: group the ENTIRE raw transcript, sort it, then filter to visible
// messages. getExportMessages already does the group+sort half (explicitly
// kept correct per the regression report); isVisibleMessage does the filter.
// useMessageProcessor's incremental cache must always slice the same tail off
// of that exact list, no matter how it got there.
// ─────────────────────────────────────────────────────────────────────────────

function oldPipelineVisible(messages: RelayMessage[]): RelayMessage[] {
  return getExportMessages(messages).filter(isVisibleMessage);
}

/** Render the hook, call loadMoreMessages `loads` times, and assert its output
 *  exactly matches the full from-scratch pipeline's slice(-renderedCount). */
function expectEquivalentAtDepth(messages: RelayMessage[], loads: number, sessionId = "session-eq") {
  const { result } = renderHook(() => useMessageProcessor(messages, sessionId));
  for (let i = 0; i < loads; i++) {
    act(() => result.current.loadMoreMessages());
  }
  const renderedCount = 50 * (loads + 1);
  const oracle = oldPipelineVisible(messages);
  const expected = oracle.slice(-renderedCount);
  expect(result.current.visibleMessages).toEqual(expected);
  expect(result.current.hasMore).toBe(oracle.length > expected.length);
}

describe("useMessageProcessor — equivalence with full-list processing", () => {
  // Probe 1: tool calls/results far apart in the raw stream must pair by
  // toolCallId, never by proximity to an arbitrary window boundary. Result A's
  // timestamp is deliberately huge (decoupled from its raw stream position) so
  // that *where it sorts to* (the visible tail) is independent of *where its
  // call is in the raw stream* (far outside any reasonable lookbehind) — this
  // is exactly the shape that made the old windowed implementation hand A's
  // result the wrong call's arguments instead of pairing it with its own call.
  test("pairs distant tool calls/results correctly (no cross-pairing at a boundary)", () => {
    const messages: RelayMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push(textMessage(i));
    messages.push({
      key: "call-A", role: "assistant", timestamp: 10,
      content: [{ type: "toolCall", id: "call-A", name: "bash", arguments: { label: "A" } }],
    });
    for (let i = 11; i < 90; i++) messages.push({ ...textMessage(i), key: `m-${i}` });
    messages.push({
      key: "call-B", role: "assistant", timestamp: 90,
      content: [{ type: "toolCall", id: "call-B", name: "bash", arguments: { label: "B" } }],
    });
    for (let i = 91; i < 100; i++) messages.push({ ...textMessage(i), key: `m-${i}` });
    messages.push({ key: "result-A", role: "toolResult", toolCallId: "call-A", toolName: "bash", timestamp: 999_999, content: "done A" });
    for (let i = 101; i < 149; i++) messages.push({ ...textMessage(i), key: `m-${i}` });
    messages.push({ key: "result-B", role: "toolResult", toolCallId: "call-B", toolName: "bash", timestamp: 149, content: "done B" });
    for (let i = 150; i < 198; i++) messages.push({ ...textMessage(i), key: `m-${i}` });

    const { result } = renderHook(() => useMessageProcessor(messages, "probe-1"));
    const toolA = result.current.visibleMessages.find((m) => m.toolCallId === "call-A");
    expect(toolA?.key).toBe("pending-tool:call-A");
    expect(toolA?.toolInput).toEqual({ label: "A" });
    expect(toolA?.content).toBe("done A");

    // Load enough to bring call-B's own item into view too and check it's untouched.
    for (let i = 0; i < 5; i++) act(() => result.current.loadMoreMessages());
    const toolB = result.current.visibleMessages.find((m) => m.key === "pending-tool:call-B");
    expect(toolB?.toolInput).toEqual({ label: "B" });
    expect(toolB?.content).toBe("done B");

    expectEquivalentAtDepth(messages, 0, "probe-1-eq");
    expectEquivalentAtDepth(messages, 5, "probe-1-eq-full");
  });

  // Probe 2: a long, unbroken run of send_message/wait_for_message/check_messages
  // tool pairs must collapse into ONE sub-agent conversation with every turn,
  // not get truncated by a lookbehind that stops at assistant tool-call messages.
  test("groups a long unbroken sub-agent run into all of its turns", () => {
    const messages: RelayMessage[] = [];
    for (let i = 0; i < 80; i++) {
      messages.push({
        key: `sa-call-${i}`, role: "assistant", timestamp: i * 2,
        content: [{ type: "toolCall", id: `sa-${i}`, name: "send_message", arguments: { message: `hi ${i}` } }],
      });
      messages.push({
        key: `sa-result-${i}`, role: "toolResult", toolCallId: `sa-${i}`, toolName: "send_message",
        timestamp: i * 2 + 1, content: `ack ${i}`,
      });
    }
    for (let i = 0; i < 49; i++) messages.push({ ...textMessage(1000 + i), key: `tail-${i}` });

    // Check at the DEFAULT render depth (no loadMoreMessages) — that's exactly
    // where the old lookbehind-based windowing truncated the run (80 turns
    // became 12) because it re-derived the window from raw messages instead of
    // the grouped stage-1 output.
    const { result } = renderHook(() => useMessageProcessor(messages, "probe-2"));
    const convo = result.current.visibleMessages.find((m) => m.role === "subAgentConversation");
    expect(convo?.subAgentTurns?.length).toBe(80);

    expectEquivalentAtDepth(messages, 0, "probe-2-eq");
    expectEquivalentAtDepth(messages, 3, "probe-2-eq-full");
  });

  // Probe 3: the stable timestamp sort must apply to the WHOLE transcript, not
  // just a raw suffix — a big out-of-order timestamp near the start still ends
  // up at the end, and timestamp-less messages (sorted as +Infinity) stay at
  // the very end too, in their original relative order.
  test("applies the global timestamp sort, not a windowed one", () => {
    const messages: RelayMessage[] = [
      { key: "huge", role: "assistant", timestamp: 999_999, content: [{ type: "text", text: "huge" }] },
      { key: "notime-a", role: "assistant", timestamp: undefined, content: [{ type: "text", text: "a" }] },
      { key: "notime-b", role: "assistant", timestamp: undefined, content: [{ type: "text", text: "b" }] },
    ];
    for (let i = 0; i < 200; i++) messages.push({ ...textMessage(i), key: `m-${i}`, timestamp: i + 3 });

    const { result } = renderHook(() => useMessageProcessor(messages, "probe-3"));
    expect(result.current.visibleMessages.slice(-3).map((m) => m.key)).toEqual(["huge:assistant:0", "notime-a:assistant:0", "notime-b:assistant:0"]);

    expectEquivalentAtDepth(messages, 0, "probe-3-eq");
  });

  // Probe 4: a run of plugin-result cards must always key off its FIRST
  // message, regardless of where the render window currently ends — loading
  // more history must never change an already-visible card's key (which would
  // remount it and lose local UI state). The 80-item run plus exactly 49
  // trailing visible messages is tuned so the old windowed implementation's
  // boundary lands mid-run (producing a "p59"-keyed card) without being
  // trimmed back out by the render-count slice, surfacing the wrong key.
  test("plugin-result run keeps a stable group key across loadMoreMessages", () => {
    const messages: RelayMessage[] = [];
    for (let i = 0; i < 200; i++) messages.push({ ...textMessage(i), key: `t-${i}` });
    for (let i = 0; i < 80; i++) {
      messages.push({
        key: `p${i}`, role: "custom", customType: PLUGIN_COMMAND_MESSAGE_TYPE,
        timestamp: 200 + i, content: "out", details: { n: i },
      });
    }
    for (let i = 0; i < 49; i++) messages.push({ ...textMessage(1000 + i), key: `u-${i}`, timestamp: 280 + i });

    const { result } = renderHook(() => useMessageProcessor(messages, "probe-4"));
    const before = result.current.visibleMessages.find((m) => m.customType === PLUGIN_COMMAND_MESSAGE_TYPE);
    expect(before?.key).toBe("p0");

    act(() => result.current.loadMoreMessages());
    const after = result.current.visibleMessages.find((m) => m.customType === PLUGIN_COMMAND_MESSAGE_TYPE);
    expect(after?.key).toBe("p0");

    expectEquivalentAtDepth(messages, 0, "probe-4-eq");
    expectEquivalentAtDepth(messages, 1, "probe-4-eq-more");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz: simulate a live, streaming transcript (random mix of plain text, tool
// call/result pairs at varying distances, sub-agent runs, and plugin-result
// runs, some messages missing a timestamp) and, at every single append step,
// assert the hook's output matches the from-scratch pipeline exactly. This is
// the harness most likely to catch an incremental-cache bug that a handful of
// hand-picked cases would miss.
// ─────────────────────────────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface FuzzState {
  messages: RelayMessage[];
  nextId: number;
  clock: number;
  pendingResults: Array<{ callId: string; toolName: string; dueAtEvent: number }>;
  eventCount: number;
}

function pushToolResult(state: FuzzState, callId: string, toolName: string) {
  state.messages.push({
    key: `result-${callId}`, role: "toolResult", toolCallId: callId, toolName,
    timestamp: state.clock++, content: `done ${callId}`,
  });
}

function runFuzzEvent(state: FuzzState, rng: () => number) {
  state.eventCount++;

  // Flush any deferred tool results whose time has come (simulates a result
  // arriving much later than its call, interspersed with other traffic).
  state.pendingResults = state.pendingResults.filter((p) => {
    if (p.dueAtEvent > state.eventCount) return true;
    pushToolResult(state, p.callId, p.toolName);
    return false;
  });

  const id = state.nextId++;
  const r = rng();
  if (r < 0.35) {
    const visible = rng() > 0.4;
    const hasTimestamp = rng() > 0.1;
    state.messages.push({
      key: `txt-${id}`, role: "assistant",
      timestamp: hasTimestamp ? state.clock++ : undefined,
      content: visible ? [{ type: "text", text: `msg ${id}` }] : [],
    });
  } else if (r < 0.55) {
    const callId = `call-${id}`;
    state.messages.push({
      key: callId, role: "assistant", timestamp: state.clock++,
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: { n: id } }],
    });
    if (rng() < 0.5) pushToolResult(state, callId, "bash");
    else state.pendingResults.push({ callId, toolName: "bash", dueAtEvent: state.eventCount + 1 + Math.floor(rng() * 20) });
  } else if (r < 0.8) {
    const toolName = ["send_message", "wait_for_message", "check_messages"][Math.floor(rng() * 3)]!;
    const callId = `sa-${id}`;
    state.messages.push({
      key: callId, role: "assistant", timestamp: state.clock++,
      content: [{ type: "toolCall", id: callId, name: toolName, arguments: { message: `hi ${id}` } }],
    });
    pushToolResult(state, callId, toolName);
  } else {
    state.messages.push({
      key: `plugin-${id}`, role: "custom", customType: PLUGIN_COMMAND_MESSAGE_TYPE,
      timestamp: state.clock++, content: "out", details: { n: id },
    });
  }
}

describe("useMessageProcessor — fuzz equivalence under incremental appends", () => {
  test("matches full reprocessing at every step of a randomized streaming session", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = makeRng(seed * 7919 + 1);
      const state: FuzzState = { messages: [], nextId: 0, clock: 0, pendingResults: [], eventCount: 0 };

      const { result, rerender } = renderHook(
        ({ messages }: { messages: RelayMessage[] }) => useMessageProcessor(messages, `fuzz-${seed}`),
        { initialProps: { messages: state.messages } },
      );

      let renderedCount = 50;
      for (let step = 0; step < 120; step++) {
        const batchSize = 1 + Math.floor(rng() * 4);
        for (let b = 0; b < batchSize; b++) runFuzzEvent(state, rng);

        const snapshot = state.messages.slice();
        rerender({ messages: snapshot });

        if (rng() < 0.08) {
          act(() => result.current.loadMoreMessages());
          renderedCount += 50;
        }

        const oracle = oldPipelineVisible(snapshot);
        const expected = oracle.slice(-renderedCount);
        expect(result.current.visibleMessages).toEqual(expected);
        expect(result.current.hasMore).toBe(oracle.length > expected.length);
      }
    }
  });

  test("falls back to a full regroup when the settled prefix is mutated (non-append update)", () => {
    const rng = makeRng(99);
    const state: FuzzState = { messages: [], nextId: 0, clock: 0, pendingResults: [], eventCount: 0 };
    for (let i = 0; i < 40; i++) runFuzzEvent(state, rng);

    const { result, rerender } = renderHook(
      ({ messages }: { messages: RelayMessage[] }) => useMessageProcessor(messages, "mutate-session"),
      { initialProps: { messages: state.messages } },
    );
    expect(result.current.visibleMessages).toEqual(oldPipelineVisible(state.messages).slice(-50));

    // Replace an early message in place (e.g. a late correction) — not a pure
    // append, so the cached settled prefix must be discarded rather than reused.
    const mutated = state.messages.slice();
    mutated[2] = { ...mutated[2]!, content: [{ type: "text", text: "edited!" }] };
    rerender({ messages: mutated });

    expect(result.current.visibleMessages).toEqual(oldPipelineVisible(mutated).slice(-50));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Perf: a single full regroup of a large, mostly-invisible history must stay
// well under the previous (buggy, window-expanding) implementation's reported
// cost, and appending a small batch to an already-processed large history must
// cost far less than reprocessing the whole thing from scratch.
// ─────────────────────────────────────────────────────────────────────────────

function mostlyInvisible(n: number): RelayMessage[] {
  const messages: RelayMessage[] = [];
  for (let i = 0; i < n; i++) {
    const visible = i % 97 === 0; // sparse visible messages force a long backward scan
    messages.push({
      key: `inv-${i}`, role: "assistant", timestamp: i,
      content: visible ? [{ type: "text", text: `msg ${i}` }] : [],
    });
  }
  return messages;
}

function toolHeavy(n: number): RelayMessage[] {
  const messages: RelayMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push({
      key: `tc-${i}`, role: "assistant", timestamp: i * 2,
      content: [{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { n: i } }],
    });
    messages.push({ key: `tr-${i}`, role: "toolResult", toolCallId: `tc-${i}`, toolName: "bash", timestamp: i * 2 + 1, content: "done" });
  }
  return messages;
}

function medianRenderMs(fn: () => void, samples = 5): number {
  const times = Array.from({ length: samples }, () => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

describe("useMessageProcessor — perf", () => {
  test("mostly-invisible 8k/16k histories process well under the old windowed-reprocess bound", () => {
    for (const n of [8000, 16000]) {
      const messages = mostlyInvisible(n);
      const ms = medianRenderMs(() => {
        const { unmount } = renderHook(() => useMessageProcessor(messages, `perf-${n}`));
        unmount();
      });
      // The buggy windowed implementation reported ~86ms at 8k and ~289ms at
      // 16k. A single full pass with no window-expansion retry loop should be
      // an order of magnitude under that; leave generous headroom for CI noise.
      expect(ms).toBeLessThan(60);
    }
  });

  test("appending a small batch to a large history doesn't reprocess the whole thing", () => {
    // Measures appendMs by growing a hook's own history sample-by-sample (each
    // sample is a genuinely new array so React's reference-equality memo can't
    // short-circuit the measurement) and compares it against the cost of a
    // from-scratch regroup of an equivalently-sized history.
    function measureAppendMs(startSize: number, batchMs = 20, samples = 3): number {
      let current = toolHeavy(startSize);
      const { rerender } = renderHook(
        ({ messages }: { messages: RelayMessage[] }) => useMessageProcessor(messages, `append-perf-${startSize}`),
        { initialProps: { messages: current } },
      );
      const times: number[] = [];
      for (let i = 0; i < samples; i++) {
        const batch = toolHeavy(batchMs).map((m, j) => ({ ...m, key: `${m.key}-append-${i}-${j}` }));
        const next = current.concat(batch);
        const start = performance.now();
        rerender({ messages: next });
        times.push(performance.now() - start);
        current = next;
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)]!;
    }

    const coldMs = medianRenderMs(() => {
      const fresh = toolHeavy(20_000); // 40k raw messages, the expensive (tool-pairing) case
      const { unmount } = renderHook(() => useMessageProcessor(fresh, "append-perf-cold"));
      unmount();
    }, 3);

    const appendMs = measureAppendMs(20_000);

    // A from-scratch regroup of the 40k-message base costs `coldMs`. Appending
    // 40 more messages on top of an already-settled history should cost a
    // small fraction of that — if it doesn't, the cache isn't being reused.
    expect(appendMs).toBeLessThan(Math.max(coldMs * 0.5, 5));

    // Appending to a BIGGER settled history shouldn't cost meaningfully more —
    // otherwise the "incremental" path is still secretly O(total size).
    const appendMsBig = measureAppendMs(40_000); // 80k raw messages
    expect(appendMsBig).toBeLessThan(appendMs * 3 + 5);
  });
});
