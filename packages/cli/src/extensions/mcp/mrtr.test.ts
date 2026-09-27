import { describe, expect, test } from "bun:test";
import { requestWithMrtr } from "./mrtr.js";
import type { McpElicitationHandler } from "./types.js";

describe("requestWithMrtr", () => {
  test("retries with current responses, fresh request calls, and exact current state", async () => {
    const sent: Record<string, unknown>[] = [];
    const states = [' {"opaque": true}  ', "next"];
    const request = async (params: Record<string, unknown>) => {
      sent.push(params);
      if (sent.length <= 2) return {
        resultType: "input_required",
        inputRequests: { [`q${sent.length}`]: { method: "elicitation/create", params: { round: sent.length } } },
        ...(sent.length === 1 ? { requestState: states[0] } : {}),
      };
      return { content: "done" };
    };

    const result = await requestWithMrtr(request, { name: "tool", arguments: { x: 1 } }, async (params) => ({ action: "accept", content: params as Record<string, unknown> }));
    expect(result).toEqual({ content: "done" });
    expect(sent[1].requestState).toBe(states[0]);
    expect(sent[1].inputResponses).toEqual({ q1: { action: "accept", content: { round: 1 } } });
    expect(sent[2]).not.toHaveProperty("requestState");
    expect(sent[2].inputResponses).toEqual({ q2: { action: "accept", content: { round: 2 } } });
  });

  test("rejects an unsupported round before partially eliciting", async () => {
    let calls = 0;
    await expect(requestWithMrtr(
      async () => ({ resultType: "input_required", inputRequests: {
        supported: { method: "elicitation/create", params: {} },
        unsupported: { method: "sampling/createMessage", params: {} },
      } }),
      {},
      async () => { calls++; return { action: "decline" }; },
    )).rejects.toThrow("Unsupported MCP MRTR input request");
    expect(calls).toBe(0);
  });

  test("preserves prototype-shaped input ids and empty opaque state", async () => {
    let sent: Record<string, unknown> | undefined;
    let round = 0;
    await requestWithMrtr(async params => {
      if (round++ === 0) return { resultType: "input_required", requestState: "", inputRequests: Object.fromEntries([["__proto__", { method: "elicitation/create", params: {} }]]) };
      sent = params;
      return { content: [] };
    }, {}, async () => ({ action: "cancel" }));
    expect(sent?.requestState).toBe("");
    expect(Object.hasOwn(sent?.inputResponses as object, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(sent?.inputResponses))["__proto__"]).toEqual({ action: "cancel" });
  });

  test("rejects malformed states and requests; bounds state-only retries", async () => {
    for (const result of [
      { resultType: "input_required" },
      { resultType: "input_required", requestState: {} },
      { resultType: "input_required", inputRequests: [] },
    ]) {
      await expect(requestWithMrtr(async () => result, {})).rejects.toThrow();
    }
    let rounds = 0;
    // State-only rounds never spin: no resume surface fails closed after ONE request.
    await expect(requestWithMrtr(async () => { rounds++; return { resultType: "input_required", requestState: "opaque" }; }, {}, undefined, undefined, 2)).rejects.toThrow("out-of-band");
    expect(rounds).toBe(1);
  });

  test("state-only rounds are driven by manual retry/cancel, echo exact state, and omit inputResponses", async () => {
    const calls: Record<string, unknown>[] = [];
    const answers: ("retry" | "cancel")[] = ["retry", "retry", "cancel"];
    const handler: McpElicitationHandler = async () => ({ action: "accept" });
    handler.resume = async () => answers.shift()!;
    const state = "opaque \u0000 state";
    await expect(requestWithMrtr(async params => { calls.push(params); return { resultType: "input_required", requestState: state }; }, { name: "t" }, handler)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(3); // initial + two manual retries, then cancel stops it
    expect(calls[1]).toEqual({ name: "t", requestState: state });
    expect("inputResponses" in calls[1]).toBe(false);
    // Resume answers stop at the first non-retry; nothing spins after cancel.
    expect(answers).toEqual([]);
  });

  test("URL consent then completion: accept has no content, second round resolves", async () => {
    let round = 0;
    const result = await requestWithMrtr(
      async params => (round++ === 0
        ? { resultType: "input_required", requestState: "s1", inputRequests: { link: { method: "elicitation/create", params: { mode: "url", url: "https://example.com/x", message: "m" } } } }
        : { content: [{ type: "text", text: JSON.stringify(params) }] }),
      { name: "t" },
      async () => ({ action: "accept" }),
    );
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ name: "t", inputResponses: { link: { action: "accept" } }, requestState: "s1" }) }] });
  });

  test("threads cancellation to the elicitation callback", async () => {
    const controller = new AbortController();
    const seen = requestWithMrtr(
      async () => ({ resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: { raw: true } } } }),
      {},
      async (params, signal) => { expect(params).toEqual({ raw: true }); expect(signal).toBe(controller.signal); return { action: "cancel" }; },
      controller.signal,
      1,
    );
    await expect(seen).rejects.toThrow("exceeded");
  });
});
