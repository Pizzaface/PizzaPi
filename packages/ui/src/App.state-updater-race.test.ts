/**
 * Regression test for GM idea RVeKYNtU.
 *
 * Problem (two related anti-patterns in App.tsx, both ultimately about
 * reading a React state update's "next value" out of band):
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
 *    initial value, so the sessionUiCache patch is skipped or wrong.
 *
 * 2. A first fix round addressed (1) for `messages` by deriving the cache
 *    patch from `messagesRef.current`, synced via a `useLayoutEffect` that
 *    only runs after React commits. That is ALSO stale-prone: if a snapshot
 *    handler (session_active) calls setMessages and then, before the commit
 *    lands, a nested handler (applyMcpReport, flushed mid-snapshot via
 *    pendingMcpReportRef) also calls setMessages, any cache patch computed
 *    from `messagesRef.current` at that point still reflects the PREVIOUS
 *    commit, not either same-tick update. Worse, the snapshot handler's own
 *    final cache patch (keyed off its local `normalizedMessages` variable)
 *    runs *after* the nested flush and overwrites whatever that flush wrote,
 *    permanently dropping the flushed message from the cache (though not
 *    from the rendered transcript, which composes correctly because React
 *    chains the functional updaters in call order regardless of this ref).
 *
 * Fix: make `messages` writes go through `applyMessagesUpdate`, a
 * write-through setter that computes "next" itself (from `messagesRef`, not
 * from React's `prev`) and updates the ref *synchronously*, before handing
 * React a plain value to commit — mirroring the existing
 * `applyMessageQueueUpdate` / `messageQueueRef` pattern. Every cache-patch
 * call site now reads `messagesRef.current` directly (never recomputes a
 * derived array from it, which would double-apply the change, and never
 * reuses an earlier local snapshot that a nested call may have superseded).
 *
 * This file combines:
 *  - static source-text checks (full React rendering of App.tsx isn't
 *    practical here) for the exact call sites named in review, and
 *  - real behavioral tests of the exported `app-session-state.ts` helpers
 *    (`applyMessageQueueUpdate`, `applyMessagesUpdate`,
 *    `resetSessionStateWithMessageQueueRef`), including a reproduction of the
 *    session_active + mid-flush-report + session-switch scenario above using
 *    those real helpers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";
import { applyMessageQueueUpdate, applyMessagesUpdate, resetSessionStateWithMessageQueueRef } from "./app-session-state";
import type { QueuedMessage } from "@/lib/types";

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

/** Extract the source of an `if (type === "eventType") { ... }` block (up to the next `if (type ===`). */
function extractTypeBlock(eventType: string): string {
  const blockStart = source.indexOf(`if (type === "${eventType}"`);
  expect(blockStart, `could not find "${eventType}" handler block`).toBeGreaterThanOrEqual(0);
  const nextBlock = source.indexOf('if (type === "', blockStart + 1);
  return source.slice(blockStart, nextBlock === -1 ? source.length : nextBlock);
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

  test("applyMcpReport derives its cache patch from a before/after messagesRef comparison, not an updater-assigned outer variable or a recomputed append", () => {
    const body = extractCallback("applyMcpReport");
    expect(body).not.toMatch(/let\s+mcpNext\b/);
    // Must snapshot the ref before the setMessages call and compare against
    // it afterward — comparing messagesRef.current against itself, or
    // recomputing the append from messagesRef.current a second time, would
    // either always skip the patch or double-apply the message.
    expect(body).toContain("const beforeMessages = messagesRef.current;");
    expect(body).toContain("if (messagesRef.current !== beforeMessages)");
    expect(body).toContain("patchSessionCache({ messages: messagesRef.current });");
  });

  test("session_active's final sessionUiCache patch reads messagesRef.current, not the pre-flush normalizedMessages snapshot", () => {
    const block = extractTypeBlock("session_active");
    // applyMcpReport may be flushed mid-handler (pendingMcpReportRef) and
    // extend messagesRef past what normalizedMessages captured earlier in
    // this same handler. The final cache patch must read the ref so that
    // flushed append isn't clobbered.
    expect(block).toContain("applyMcpReport(pendingMcpReportRef.current);");
    const patchCalls = [...block.matchAll(/messages:\s*([\w.]+),/g)].map((m) => m[1]);
    expect(patchCalls.length, "expected exactly two patchSessionCache({ messages: ... }) calls in session_active").toBe(2);
    expect(patchCalls).toEqual(["messagesRef.current", "messagesRef.current"]);
  });

  for (const eventType of ["mcp_auth_required", "mcp_auth_paste_required", "mcp_auth_complete", "cli_error"]) {
    test(`"${eventType}" handler uses a functional setMessages updater instead of an absolute replacement`, () => {
      const block = extractTypeBlock(eventType);
      // setMessages must be called with a functional updater (an arrow
      // function), never a bare pre-computed array variable.
      expect(block).toMatch(/setMessages\(\s*\(prev\)\s*=>/);
      expect(block).not.toMatch(/setMessages\(\s*(next|nextMessages|filteredNext|errMessage)\s*\)/);
      // And the cache patch must read messagesRef.current directly, never
      // recompute a derived array from it (that would double-apply the
      // change now that setMessages writes the ref synchronously).
      expect(block).not.toMatch(/patchSessionCache\(\{\s*messages:\s*(replaceMessageByStableKey|removeMessagesByStableKey)\(messagesRef\.current/);
      expect(block).not.toMatch(/patchSessionCache\(\{\s*messages:\s*\[\.\.\.messagesRef\.current/);
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

  test("every patchSessionCache({ messages: ... }) call either reads messagesRef.current directly or passes an explicitly-reviewed local snapshot", () => {
    // A `messages:` patch field built from anything other than a direct
    // `messagesRef.current` read is suspect: it can only be correct if
    // nothing else touched messagesRef between that snapshot being taken and
    // this patch running, which is exactly the invariant the GM RVeKYNtU bug
    // violated. Recomputing a derived array *from* messagesRef.current is
    // also wrong post-fix: setMessages already wrote the ref, so re-deriving
    // would double-apply the change.
    const patchFields = [...sourceNoComments.matchAll(/patchSessionCache\(\{\s*messages:\s*([^,}]+)[,}]/g)].map((m) => m[1].trim());

    const reviewedLocalSnapshots = [
      "[]", // new_session reset
      "withInjected", // agent_end: patched immediately after its own setMessages, no nested call in between
    ];

    const unreviewed = patchFields.filter((f) => f !== "messagesRef.current" && !reviewedLocalSnapshots.includes(f));
    expect(unreviewed, `found an unreviewed patchSessionCache messages field: ${JSON.stringify(unreviewed)}`).toEqual([]);
  });

  test("message queue and messages writers, plus full session reset, use the shared write-through ref-sync helpers", () => {
    const setMessageQueueBody = extractCallback("setMessageQueue");
    expect(setMessageQueueBody).toContain("applyMessageQueueUpdate(v, messageQueueRef, setSessionState)");

    // setMessages has a single-expression (braceless) arrow body, so check
    // the declaration text directly rather than via extractCallback (which
    // expects a `{ ... }` block).
    expect(source).toContain("applyMessagesUpdate(v, messagesRef, setSessionState)");

    const clearSelectionBody = extractCallback("clearSelection");
    expect(clearSelectionBody).toContain(
      "resetSessionStateWithMessageQueueRef(createInitialSessionState, messageQueueRef, messagesRef, setSessionState)",
    );
  });

  test("behavioral: production message queue helper composes correctly across synchronous batched calls", () => {
    const first = { id: "first" } as unknown as QueuedMessage;
    const second = { id: "second" } as unknown as QueuedMessage;

    function useQueueLikeState() {
      const [state, setState] = React.useState(() => ({ messageQueue: [] as QueuedMessage[], label: "active" }));
      const queueRef = React.useRef<QueuedMessage[]>(state.messageQueue);
      React.useLayoutEffect(() => { queueRef.current = state.messageQueue; }, [state.messageQueue]);
      const setQueue = React.useCallback((v: React.SetStateAction<QueuedMessage[]>) => {
        applyMessageQueueUpdate(v, queueRef, setState);
      }, []);
      return { state, queueRef, setQueue };
    }

    const { result } = renderHook(() => useQueueLikeState());

    act(() => {
      result.current.setQueue((prev) => [...prev, first]);
      expect(result.current.queueRef.current).toEqual([first]);
      result.current.setQueue((prev) => prev.filter((x) => x !== first).concat(second));
    });

    expect(result.current.state.messageQueue).toEqual([second]);
    expect(result.current.queueRef.current).toEqual([second]);
  });

  test("behavioral: production messages helper composes correctly across synchronous batched calls", () => {
    type Msg = { key: string };
    const snapshot = { key: "snapshot:1" } as Msg;
    const report = { key: "mcp_startup:1" } as Msg;

    function useMessagesLikeState() {
      const [state, setState] = React.useState(() => ({ messages: [] as Msg[], label: "active" }));
      const messagesRef = React.useRef<Msg[]>(state.messages);
      React.useLayoutEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
      const setMessages = React.useCallback((v: React.SetStateAction<Msg[]>) => {
        return applyMessagesUpdate(v, messagesRef, setState);
      }, []);
      return { state, messagesRef, setMessages };
    }

    const { result } = renderHook(() => useMessagesLikeState());

    // Two synchronous, batched calls in the same tick: an absolute snapshot
    // replace followed by a functional append (the exact shape of
    // session_active calling setMessages, then applyMcpReport's functional
    // setMessages, in the same handler invocation).
    act(() => {
      result.current.setMessages([snapshot]);
      // The ref must already reflect the snapshot synchronously, before any
      // commit — this is the property the old useLayoutEffect-only sync did
      // not have.
      expect(result.current.messagesRef.current).toEqual([snapshot]);
      result.current.setMessages((prev) => [...prev, report]);
      expect(result.current.messagesRef.current).toEqual([snapshot, report]);
    });

    expect(result.current.state.messages).toEqual([snapshot, report]);
    expect(result.current.messagesRef.current).toEqual([snapshot, report]);
  });

  test("behavioral: a pending MCP report flushed mid-snapshot is not dropped from the sessionUiCache entry across a session switch away and back", () => {
    // Mirrors the real control flow fixed in this PR: session_active installs
    // a snapshot, flushes a pending MCP report mid-handler via a nested
    // applyMcpReport-like call, and then patches the sessionUiCache using the
    // CURRENT ref (not the normalizedMessages snapshot captured before the
    // nested flush). Uses the real exported applyMessagesUpdate so this test
    // actually exercises the production write-through mechanism, not a
    // reimplementation of it.
    type Msg = { key: string };
    const snapshotMsg: Msg = { key: "snapshot:1" };
    const reportMsg: Msg = { key: "mcp_startup:1" };

    function useSessionLikeState() {
      const [state, setState] = React.useState(() => ({ messages: [] as Msg[] }));
      const messagesRef = React.useRef<Msg[]>(state.messages);
      React.useLayoutEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
      const cacheRef = React.useRef<Map<string, { messages: Msg[] }>>(new Map());
      const activeSessionIdRef = React.useRef<string>("session-a");

      const setMessages = React.useCallback((v: React.SetStateAction<Msg[]>) => {
        return applyMessagesUpdate(v, messagesRef, setState);
      }, []);

      const patchCache = React.useCallback((messages: Msg[]) => {
        cacheRef.current.set(activeSessionIdRef.current, { messages });
      }, []);

      // Mirrors applyMcpReport: snapshot the ref, functional-append, then
      // patch only if something actually changed (comparing against the
      // snapshot, never re-deriving from the now-updated ref).
      const applyMcpReportLike = React.useCallback((msg: Msg) => {
        const before = messagesRef.current;
        setMessages((prev) => [...prev, msg]);
        if (messagesRef.current !== before) {
          patchCache(messagesRef.current);
        }
      }, [patchCache, setMessages]);

      // Mirrors session_active: install the snapshot, flush a pending report
      // mid-handler, then patch using the ref (reflecting both writes) —
      // not the normalizedMessages snapshot captured before the flush.
      const applySnapshot = React.useCallback((normalizedMessages: Msg[], pendingReport: Msg | null) => {
        setMessages(normalizedMessages);
        if (pendingReport) applyMcpReportLike(pendingReport);
        patchCache(messagesRef.current);
      }, [applyMcpReportLike, patchCache, setMessages]);

      const switchAway = React.useCallback(() => {
        activeSessionIdRef.current = "session-b";
        setMessages([]);
      }, [setMessages]);

      const switchBack = React.useCallback(() => {
        activeSessionIdRef.current = "session-a";
        setMessages(cacheRef.current.get("session-a")?.messages ?? []);
      }, [setMessages]);

      return { state, cacheRef, applySnapshot, switchAway, switchBack };
    }

    const { result } = renderHook(() => useSessionLikeState());

    act(() => {
      result.current.applySnapshot([snapshotMsg], reportMsg);
    });

    // The cache entry for session-a must contain BOTH the snapshot and the
    // report flushed mid-handler — this is the exact clobber the review found.
    expect(result.current.cacheRef.current.get("session-a")?.messages).toEqual([snapshotMsg, reportMsg]);

    act(() => {
      result.current.switchAway();
      result.current.switchBack();
    });

    // Switching away and back must restore the full transcript, not a
    // truncated one missing the flushed report.
    expect(result.current.state.messages).toEqual([snapshotMsg, reportMsg]);
  });

  test("behavioral: production reset helper clears messageQueueRef and messagesRef before a same-batch update", () => {
    const oldQueueItem = { id: "old" } as unknown as QueuedMessage;
    const newQueueItem = { id: "new" } as unknown as QueuedMessage;
    type Msg = { key: string };
    const oldMsg: Msg = { key: "old" };
    const newMsg: Msg = { key: "new" };

    function useSessionStateLike() {
      const [state, setState] = React.useState(() => ({
        messageQueue: [oldQueueItem] as QueuedMessage[],
        messages: [oldMsg] as Msg[],
        label: "old",
      }));
      const queueRef = React.useRef<QueuedMessage[]>(state.messageQueue);
      React.useLayoutEffect(() => { queueRef.current = state.messageQueue; }, [state.messageQueue]);
      const messagesRef = React.useRef<Msg[]>(state.messages);
      React.useLayoutEffect(() => { messagesRef.current = state.messages; }, [state.messages]);
      const reset = React.useCallback(() => {
        resetSessionStateWithMessageQueueRef(
          () => ({ messageQueue: [], messages: [], label: "new" }),
          queueRef,
          messagesRef,
          setState,
        );
      }, []);
      const setQueue = React.useCallback((v: React.SetStateAction<QueuedMessage[]>) => {
        applyMessageQueueUpdate(v, queueRef, setState);
      }, []);
      const setMessages = React.useCallback((v: React.SetStateAction<Msg[]>) => {
        applyMessagesUpdate(v, messagesRef, setState);
      }, []);
      return { state, queueRef, messagesRef, reset, setQueue, setMessages };
    }

    const { result } = renderHook(() => useSessionStateLike());

    act(() => {
      result.current.reset();
      expect(result.current.queueRef.current).toEqual([]);
      expect(result.current.messagesRef.current).toEqual([]);
      result.current.setQueue((prev) => [...prev, newQueueItem]);
      result.current.setMessages((prev) => [...prev, newMsg]);
    });

    expect(result.current.state).toEqual({ messageQueue: [newQueueItem], messages: [newMsg], label: "new" });
    expect(result.current.queueRef.current).toEqual([newQueueItem]);
    expect(result.current.messagesRef.current).toEqual([newMsg]);
  });
});
