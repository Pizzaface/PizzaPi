import { afterEach, describe, expect, test } from "bun:test";
import { loadAgents } from "./agent-loader";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

describe("loadAgents", () => {
  test("refreshes the runner cache after its TTL", async () => {
    let now = 1_000;
    Date.now = () => now;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify({ agents: [{ name: `agent-${requests}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(loadAgents("ttl-regression-runner")).resolves.toEqual([{ name: "agent-1" }]);
    now += 4_999;
    await expect(loadAgents("ttl-regression-runner")).resolves.toEqual([{ name: "agent-1" }]);
    expect(requests).toBe(1);

    now += 1;
    await expect(loadAgents("ttl-regression-runner")).resolves.toEqual([{ name: "agent-2" }]);
    expect(requests).toBe(2);
  });
});
