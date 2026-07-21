import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchRunnerModelVisibility, loadHiddenModels, saveHiddenModels } from "./model-visibility.js";

const originalFetch = globalThis.fetch;
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});

afterEach(() => {
  values.clear();
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("runner model visibility", () => {
  test("keeps browser caches scoped by runner", () => {
    values.set("pp-hidden-models:runner-a", JSON.stringify(["openai/a"]));
    values.set("pp-hidden-models:runner-b", JSON.stringify(["openai/b"]));
    expect([...loadHiddenModels("runner-a")]).toEqual(["openai/a"]);
    expect([...loadHiddenModels("runner-b")]).toEqual(["openai/b"]);
  });

  test("retrieves the full catalog and visibility policy from the runner endpoint", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      models: [{ provider: "openai", id: "visible" }],
      allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
      hiddenModels: ["openai/hidden"],
    }), { status: 200 }))) as any;

    const result = await fetchRunnerModelVisibility("runner/a");
    expect(result.models.map((model) => model.id)).toEqual(["visible", "hidden"]);
    expect([...result.hiddenModels]).toEqual(["openai/hidden"]);
    expect(fetch).toHaveBeenCalledWith("/api/runners/runner%2Fa/models", { credentials: "include" });
  });

  test("writes visibility changes to the runner endpoint", () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as any;
    saveHiddenModels("runner-a", new Set(["openai/hidden"]));
    expect(fetch).toHaveBeenCalledWith("/api/runners/runner-a/models", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ hiddenModels: ["openai/hidden"] }),
    }));
  });
});
