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

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

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
});
