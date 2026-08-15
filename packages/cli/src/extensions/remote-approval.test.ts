import { describe, test, expect } from "bun:test";
import { consumePendingApprovalFromWeb, cancelPendingApproval } from "./remote-approval.js";
import type { RelayContext } from "./remote-types.js";
import type { ApprovalDecision } from "@pizzapi/protocol";

/** Minimal RelayContext stub exercising only what the approval path touches. */
function makeRctx(): { rctx: RelayContext; events: unknown[] } {
  const events: unknown[] = [];
  const rctx = {
    pendingApproval: null,
    relay: {},
    forwardEvent: (e: unknown) => events.push(e),
    setRelayStatus: () => {},
    disconnectedStatusText: () => "Disconnected",
  } as unknown as RelayContext;
  return { rctx, events };
}

function setPending(rctx: RelayContext, promptId: string, resolve: (d: ApprovalDecision | null) => void) {
  rctx.pendingApproval = { promptId, resolve };
}

describe("consumePendingApprovalFromWeb", () => {
  test("returns false when nothing is pending", () => {
    const { rctx } = makeRctx();
    expect(consumePendingApprovalFromWeb(rctx, '{"action":"approve"}')).toBe(false);
  });

  test("does not swallow a normal message while pending", () => {
    const { rctx } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    expect(consumePendingApprovalFromWeb(rctx, "hey can you also cc bob")).toBe(false);
    expect(rctx.pendingApproval).not.toBeNull();
    expect(resolved).toBeUndefined();
  });

  test("resolves an approve decision and clears pending", () => {
    const { rctx, events } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "approve", promptId: "p1" }))).toBe(true);
    expect(resolved).toEqual({ action: "approve", approved: true });
    expect(rctx.pendingApproval).toBeNull();
    expect(events).toContainEqual({ type: "approval_cleared", promptId: "p1" });
  });

  test("carries edited field values through", () => {
    const { rctx } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "approve", edits: { body: "New body", n: 5 } }));
    expect(resolved).toEqual({ action: "approve", approved: true, edits: { body: "New body" } });
  });

  test("reject decision is not approved", () => {
    const { rctx } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "reject" }));
    expect(resolved).toEqual({ action: "reject", approved: false });
  });

  test("ignores a decision for a different prompt id", () => {
    const { rctx } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "approve", promptId: "OTHER" }))).toBe(false);
    expect(resolved).toBeUndefined();
    expect(rctx.pendingApproval).not.toBeNull();
  });
});

describe("cancelPendingApproval", () => {
  test("fails closed (rejects) and clears", () => {
    const { rctx, events } = makeRctx();
    let resolved: ApprovalDecision | null | undefined;
    setPending(rctx, "p1", (d) => { resolved = d; });
    cancelPendingApproval(rctx);
    expect(resolved).toEqual({ action: "reject", approved: false });
    expect(rctx.pendingApproval).toBeNull();
    expect(events).toContainEqual({ type: "approval_cleared", promptId: "p1" });
  });

  test("no-op when nothing pending", () => {
    const { rctx, events } = makeRctx();
    cancelPendingApproval(rctx);
    expect(events).toHaveLength(0);
  });
});
