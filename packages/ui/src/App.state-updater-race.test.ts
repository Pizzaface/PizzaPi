/**
 * Regression test for GM idea RVeKYNtU.
 *
 * Problem (two related anti-patterns in App.tsx):
 *
 * 1. Several handlers assigned an outer-scope variable inside a functional
 *    setState updater and read it back immediately afterward, e.g.:
 *      let nextQueue = [];
 *      setMessageQueue((prev) => { nextQueue = reconcile(prev); return nextQueue; });
 *      patchSessionCache({ messageQueue: nextQueue });
 *    React only computes the updater eagerly/synchronously when the fiber has
 *    no other update already pending (its "eager bailout" optimization) —
 *    not guaranteed while streaming/heartbeats keep updates in flight. When
 *    that optimization doesn't kick in, `nextQueue` stays at its stale
 *    initial value, so the sessionUiCache patch is skipped or wrong, and a
 *    later session-switch restores a stale queue/messages list.
 *
 * 2. Other handlers (mcp_auth_*, cli_error) built an absolute "next" array
 *    from messagesRef.current and called setMessages(next) directly. Because
 *    that's a plain (non-functional) update, React applies it by replacing
 *    whatever the *actual* previous state resolves to — discarding any
 *    functional update already queued in the same batch (e.g. a streaming
 *    delta), rather than chaining on top of it.
 *
 * Fix: never read a setState updater's return value back out through an
 * outer variable; derive the next value from a committed-state ref (synced
 * via useLayoutEffect) instead. And always pass setMessages a functional
 * updater, never a precomputed absolute array, so it composes correctly with
 * concurrently pending updates.
 *
 * This test statically verifies the fixed call sites no longer contain
 * either anti-pattern, by extracting their source text directly from
 * App.tsx (full React rendering/scheduling isn't practical to simulate here
 * — the bug is about *when* React happens to run an updater).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
// Strip line comments before source-text scanning below so comment prose
// (e.g. explaining an anti-pattern) can't be mistaken for a real call site.
const sourceNoComments = source
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

/** Extract the source of a `const name = React.useCallback((...) => { ... }, [...]);` declaration. */
function extractCallback(name: string): string {
  const declIdx = source.indexOf(`const ${name} = React.useCallback(`);
  expect(declIdx, `could not find declaration for ${name}`).toBeGreaterThanOrEqual(0);

  // Find the start of the callback body: the `{` immediately after the
  // arrow's `=>`. Using the first `{` after the declaration would instead
  // match a parameter type's object-literal annotation (e.g. `(x: { a: ... }) =>`).
  const arrowIdx = source.indexOf("=>", declIdx);
  expect(arrowIdx, `could not find arrow for ${name}`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", arrowIdx);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  expect(i, `could not find matching closing brace for ${name}`).toBeLessThan(source.length);
  return source.slice(bodyStart, i + 1);
}

describe("App.tsx setState-updater race regression (GM RVeKYNtU)", () => {
  test("applyQueuedMessagesSync derives its cache patch from messageQueueRef, not an updater-assigned outer variable", () => {
    const body = extractCallback("applyQueuedMessagesSync");
    expect(body).not.toMatch(/let\s+(nextQueue|changed)\b/);
    expect(body).toContain("messageQueueRef.current");
  });

  test("removeQueuedMessageByContent derives its cache patch from messageQueueRef, not an updater-assigned outer variable", () => {
    const body = extractCallback("removeQueuedMessageByContent");
    expect(body).not.toMatch(/let\s+nextQueue\b/);
    expect(body).toContain("messageQueueRef.current");
  });

  test("applyMcpReport does not read its setMessages updater's result back through an outer variable", () => {
    const body = extractCallback("applyMcpReport");
    expect(body).not.toMatch(/let\s+mcpNext\b/);
    // The cache patch must be derived from messagesRef (synced post-commit),
    // not from the updater's return value.
    expect(body).toContain("messagesRef.current");
  });

  for (const eventType of ["mcp_auth_required", "mcp_auth_paste_required", "mcp_auth_complete", "cli_error"]) {
    test(`"${eventType}" handler uses a functional setMessages updater instead of an absolute replacement`, () => {
      const blockStart = source.indexOf(`if (type === "${eventType}")`);
      expect(blockStart, `could not find "${eventType}" handler block`).toBeGreaterThanOrEqual(0);
      // The next "if (type ===" marks the start of the following block; use it
      // (or end of file) as a bound so we only inspect this handler's body.
      const nextBlock = source.indexOf('if (type === "', blockStart + 1);
      const block = source.slice(blockStart, nextBlock === -1 ? source.length : nextBlock);

      // setMessages must be called with a functional updater (an arrow
      // function), never a bare pre-computed array variable.
      expect(block).toMatch(/setMessages\(\s*\(prev\)\s*=>/);
      expect(block).not.toMatch(/setMessages\(\s*(next|nextMessages|filteredNext|errMessage)\s*\)/);
    });
  }

  // The tests above only check a hand-picked allowlist of call sites named at
  // fix time. A prior review round fixed three named call sites but missed
  // five sibling setMessageQueue writers and two setMessages writers (the MCP
  // paste-dismiss / server-disable callbacks) with the exact same bug shape.
  // These tests scan the WHOLE file generically so a NEW call site with
  // either anti-pattern fails even if nobody adds it to an allowlist.

  test("every setMessages(...) call in App.tsx is either a functional updater or an explicitly-reviewed authoritative full replace", () => {
    const nonFunctionalCalls = [...sourceNoComments.matchAll(/setMessages\(\s*((?!\(\s*prev)[^)]*)\)/g)].map((m) => m[0].trim());

    // Each entry is a full snapshot/reset replace that was reviewed and is
    // intentionally not a functional updater (it runs after
    // cancelPendingDeltas(), or is an authoritative session reset/switch, not
    // a stale-ref-derived patch). A new absolute setMessages(...) call must
    // either become functional or get a reviewed, justified entry here.
    const reviewedAbsoluteReplaces = [
      "setMessages(injected.length > 0 ? [...normalizedMessages, ...injected] : normalizedMessages)",
      "setMessages(withInjected)",
      "setMessages([])",
      "setMessages(cached?.messages ?? [])",
    ];

    const unreviewed = nonFunctionalCalls.filter((call) => !reviewedAbsoluteReplaces.includes(call));
    expect(unreviewed, `found unreviewed absolute setMessages(...) call(s): ${JSON.stringify(unreviewed)}`).toEqual([]);
  });

  test("every setMessageQueue(...) call keeps messageQueueRef in sync by construction (single-setter invariant)", () => {
    // Root-cause fix: instead of requiring every call site to remember to
    // also write messageQueueRef.current, setMessageQueue itself does it, so
    // ALL current and future call sites inherit the invariant for free.
    const setterBody = extractCallback("setMessageQueue");
    expect(setterBody).toContain("messageQueueRef.current");
    // The ref write must happen before setSessionState is called, so a
    // same-tick follow-up read (another queue mutation in the same handler,
    // or a later call in the same batch) sees the result immediately instead
    // of waiting for the commit-time useLayoutEffect.
    const refWriteIdx = setterBody.indexOf("messageQueueRef.current =");
    const setSessionStateIdx = setterBody.indexOf("setSessionState(");
    expect(refWriteIdx).toBeGreaterThanOrEqual(0);
    expect(setSessionStateIdx).toBeGreaterThan(refWriteIdx);
  });

  test("behavioral: a single ref-syncing setter composes correctly across synchronous batched calls (GM RVeKYNtU pattern)", () => {
    // Mounting the real multi-thousand-line App component is not practical in
    // a unit test (it needs a live socket/relay and dozens of other hooks) --
    // consistent with every other test in this file. This exercises the same
    // *pattern* setMessageQueue now uses, under React's real scheduler, to
    // prove the pattern holds under batching (the two static tests above
    // prove App.tsx's actual setter uses this exact pattern).
    function useQueueLikeState() {
      const [queue, setQueueState] = React.useState<string[]>([]);
      const queueRef = React.useRef<string[]>(queue);
      React.useLayoutEffect(() => { queueRef.current = queue; }, [queue]);
      const setQueue = React.useCallback((v: string[] | ((prev: string[]) => string[])) => {
        const next = typeof v === "function" ? (v as (prev: string[]) => string[])(queueRef.current) : v;
        queueRef.current = next;
        setQueueState(next);
      }, []);
      return { queue, queueRef, setQueue };
    }

    const { result } = renderHook(() => useQueueLikeState());

    // Two queue mutations issued synchronously in the same event-handler tick
    // (React batches both into one render) -- the second must observe the
    // first's result via the ref, not a stale snapshot.
    act(() => {
      result.current.setQueue((prev) => [...prev, "a"]);
      // If the ref were not updated synchronously by setQueue, this read would
      // still see [] here (pre-fix behavior relied on React's eager-bailout
      // optimization running the first updater immediately, which is not
      // guaranteed while another update is already pending on the fiber).
      expect(result.current.queueRef.current).toEqual(["a"]);
      result.current.setQueue((prev) => prev.filter((x) => x !== "a").concat("b"));
    });

    expect(result.current.queue).toEqual(["b"]);
    expect(result.current.queueRef.current).toEqual(["b"]);
  });
});
