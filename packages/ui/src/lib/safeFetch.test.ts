import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { safeFetch, fireAndForget, safeFetchJson } from "./safeFetch";

const originalFetch = globalThis.fetch;
let consoleWarnSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleDebugSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleDebugSpy.mockRestore();
});

describe("safeFetch", () => {
  test("returns response on successful fetch", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("OK", { status: 200 })));
    const result = await safeFetch("/api/test");
    expect(result?.ok).toBe(true);
  });

  test("returns null on non-ok response", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("Not Found", { status: 404 })));
    expect(await safeFetch("/api/test")).toBeNull();
  });

  test("returns null on network error", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
    expect(await safeFetch("/api/test")).toBeNull();
  });
});

describe("fireAndForget", () => {
  test("does not throw on failure", () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
    expect(() => fireAndForget("/api/test")).not.toThrow();
  });
});

describe("safeFetchJson", () => {
  test("returns parsed JSON on success", async () => {
    const testData = { name: "test" };
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(testData), { status: 200 })));
    expect(await safeFetchJson("/api/test")).toEqual(testData);
  });
});
