import { describe, expect, test } from "bun:test";
import { reconcileMessageQueue } from "./message-queue";
import type { QueuedMessage } from "./types";

const qm = (id: string, text: string): QueuedMessage => ({ id, text, deliverAs: "followUp", timestamp: 1 });

describe("reconcileMessageQueue", () => {
  test("returns same reference when nothing changed", () => {
    const prev = [qm("a", "one"), qm("b", "two")];
    expect(reconcileMessageQueue(prev, ["one", "two"])).toBe(prev);
  });

  test("preserves ids for matching texts and drops consumed entries", () => {
    const prev = [qm("a", "one"), qm("b", "two"), qm("c", "three")];
    const next = reconcileMessageQueue(prev, ["two", "three"]);
    expect(next.map((m) => m.id)).toEqual(["b", "c"]);
  });

  test("adds entries for texts queued elsewhere (e.g. TUI)", () => {
    const prev = [qm("a", "one")];
    const next = reconcileMessageQueue(prev, ["one", "tui-queued"]);
    expect(next[0].id).toBe("a");
    expect(next[1].text).toBe("tui-queued");
    expect(next[1].deliverAs).toBe("followUp");
  });

  test("empty runner queue clears local list", () => {
    const prev = [qm("a", "one")];
    expect(reconcileMessageQueue(prev, [])).toEqual([]);
  });

  test("duplicate texts map to distinct entries", () => {
    const prev = [qm("a", "same"), qm("b", "same")];
    const next = reconcileMessageQueue(prev, ["same", "same"]);
    expect(next.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
