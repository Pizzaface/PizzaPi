import { describe, test, expect } from "bun:test";
import { consumePendingApprovalFromWeb, cancelPendingApproval, requestApprovalViaWeb, registerApprovalBridge, getApprovalHandler } from "./remote-approval.js";
import type { RelayContext } from "./remote-types.js";
import type { ApprovalDecision } from "@pizzapi/protocol";

/** Minimal RelayContext stub exercising only what the approval path touches. */
function makeRctx(): { rctx: RelayContext; events: unknown[] } {
  const events: unknown[] = [];
  const rctx = {
    pendingApproval: null,
    isConnected: () => true,
    pi: {},
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

describe("approval bridge for MCP forms", () => {
  test("passes cancellation through and does not overwrite an existing prompt", async () => {
    const { rctx } = makeRctx();
    const dispose = registerApprovalBridge(rctx);
    const ac = new AbortController();
    try {
      const first = getApprovalHandler()!({ title: "MCP server: contacts" }, ac.signal);
      const id = rctx.pendingApproval?.promptId;
      expect(await requestApprovalViaWeb(rctx, { title: "Second" })).toMatchObject({ unavailable: true });
      expect(rctx.pendingApproval?.promptId).toBe(id);
      ac.abort();
      expect(await first).toEqual({ action: "reject", approved: false });
      expect(rctx.pendingApproval).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe("approval bridge for MCP URL consent", () => {
  test("forwards only http(s) hrefs, requires a matching promptId, and fails closed on disconnect", async () => {
    const { rctx, events } = makeRctx();
    const dispose = registerApprovalBridge(rctx);
    try {
      const request = {
        title: "MCP server: payments",
        actions: [
          { id: "open", label: "Open in browser", href: "https://mcp.example.com/ui" },
          { id: "evil", label: "Nope", href: "javascript:alert(1)" },
          { id: "cancel", label: "Cancel" },
        ],
      };
      const first = getApprovalHandler()!(request);
      const pending = events.find(e => (e as { type: string }).type === "approval_pending") as { approval: { promptId: string; actions: Array<{ id: string; href?: string }> } };
      expect(pending.approval.actions.map(a => a.href)).toEqual(["https://mcp.example.com/ui", undefined, undefined]);
      // A decision without the promptId cannot consent to opening a URL.
      expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "open" }))).toBe(false);
      expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "open", promptId: "other" }))).toBe(false);
      expect(rctx.pendingApproval?.promptId).toBe(pending.approval.promptId);
      expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "open", promptId: pending.approval.promptId }))).toBe(true);
      expect(await first).toEqual({ action: "open", approved: false });

      // Reconnect/cancel path: a pending consent is rejected, never accepted.
      const second = getApprovalHandler()!(request);
      cancelPendingApproval(rctx);
      expect(await second).toEqual({ action: "reject", approved: false });

      // Plain approvals keep accepting id-less decisions.
      const third = getApprovalHandler()!({ title: "Plain" });
      expect(consumePendingApprovalFromWeb(rctx, JSON.stringify({ action: "approve" }))).toBe(true);
      expect(await third).toMatchObject({ action: "approve", approved: true });
    } finally {
      dispose();
    }
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
