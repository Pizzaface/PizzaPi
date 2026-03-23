import { describe, test, expect } from "bun:test";
import { evictLruIfNeeded, touchSessionCache, MAX_SESSION_UI_CACHE_SIZE } from "./session-ui-cache.js";
import type { SessionUiCacheEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SessionUiCacheEntry with a controlled lastAccessed time. */
function makeEntry(lastAccessed: number): SessionUiCacheEntry {
  return {
    messages: [],
    activeModel: null,
    sessionName: null,
    availableModels: [],
    availableCommands: [],
    agentActive: false,
    isCompacting: false,
    effortLevel: null,
    planModeEnabled: false,
    authSource: null,
    tokenUsage: null,
    providerUsage: null,
    lastHeartbeatAt: null,
    todoList: [],
    pendingQuestion: null,
    pendingPlan: null,
    lastAccessed,
  };
}

/**
 * Populate a map with `count` entries whose keys are "s0", "s1", …
 * and whose `lastAccessed` values are 1000, 2000, … (oldest = "s0").
 */
function makeCache(count: number): Map<string, SessionUiCacheEntry> {
  const cache = new Map<string, SessionUiCacheEntry>();
  for (let i = 0; i < count; i++) {
    cache.set(`s${i}`, makeEntry((i + 1) * 1000));
  }
  return cache;
}

// ---------------------------------------------------------------------------
// MAX_SESSION_UI_CACHE_SIZE constant
// ---------------------------------------------------------------------------

describe("MAX_SESSION_UI_CACHE_SIZE", () => {
  test("is 50", () => {
    expect(MAX_SESSION_UI_CACHE_SIZE).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// evictLruIfNeeded
// ---------------------------------------------------------------------------

describe("evictLruIfNeeded — no-op cases", () => {
  test("does not evict when cache is below capacity", () => {
    const cache = makeCache(3);
    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.size).toBe(3); // still 3; nothing evicted
  });

  test("does not evict when cache is exactly at capacity but key already exists (update, not insert)", () => {
    const cache = makeCache(5);
    // "s0" is already in the map — this is an update, not a new insertion.
    evictLruIfNeeded(cache, "s0", 5);
    expect(cache.size).toBe(5);
    expect(cache.has("s0")).toBe(true);
  });

  test("does not evict when cache size is one below the limit", () => {
    const cache = makeCache(4);
    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe("evictLruIfNeeded — size limit enforcement", () => {
  test("evicts exactly one entry when cache is at capacity and a new key is inserted", () => {
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5);
    // One entry should have been removed to make room.
    expect(cache.size).toBe(4);
  });

  test("does not evict more than one entry per call", () => {
    // Even if the cache is far over the theoretical limit (shouldn't happen in
    // normal usage but the function should remain stable).
    const cache = makeCache(10);
    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.size).toBe(9); // exactly one eviction
  });

  test("new key is NOT inserted by evictLruIfNeeded (caller's responsibility)", () => {
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5);
    // The utility only evicts; inserting the new entry is the caller's job.
    expect(cache.has("new-session")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("evictLruIfNeeded — LRU selection", () => {
  test("evicts the entry with the smallest lastAccessed value", () => {
    const cache = makeCache(5);
    // s0 → lastAccessed=1000 (oldest/LRU)
    // s1 → 2000, s2 → 3000, s3 → 4000, s4 → 5000 (newest/MRU)
    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.has("s0")).toBe(false); // oldest evicted
    expect(cache.has("s1")).toBe(true);
    expect(cache.has("s4")).toBe(true);
  });

  test("evicts the correct entry when lastAccessed values are not in insertion order", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("alpha", makeEntry(9000)); // newest
    cache.set("beta", makeEntry(1000));  // oldest → should be evicted
    cache.set("gamma", makeEntry(5000));
    cache.set("delta", makeEntry(3000));
    cache.set("epsilon", makeEntry(7000));

    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.has("beta")).toBe(false);
    expect(cache.size).toBe(4);
  });

  test("when two entries share the smallest lastAccessed, one of them (the first encountered) is evicted", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("a", makeEntry(1000)); // tied for oldest
    cache.set("b", makeEntry(1000)); // tied for oldest
    cache.set("c", makeEntry(2000));
    cache.set("d", makeEntry(3000));
    cache.set("e", makeEntry(4000));

    evictLruIfNeeded(cache, "new-session", 5);
    expect(cache.size).toBe(4);
    // Either "a" or "b" may be gone, but not both.
    const evictedCount = ["a", "b"].filter((k) => !cache.has(k)).length;
    expect(evictedCount).toBe(1);
    expect(cache.has("c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("evictLruIfNeeded — active session protection", () => {
  test("does not evict the activeKey even if it is the LRU", () => {
    // "s0" is the LRU (lastAccessed=1000) but it is the active session.
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5, "s0");
    expect(cache.has("s0")).toBe(true); // active session protected
    expect(cache.size).toBe(4);        // something else was evicted
    // "s1" is the next oldest (2000) and should have been evicted.
    expect(cache.has("s1")).toBe(false);
  });

  test("evicts the true LRU when activeKey is the second-oldest", () => {
    const cache = makeCache(5);
    // s1 (lastAccessed=2000) is active; s0 (1000) is older and can be evicted.
    evictLruIfNeeded(cache, "new-session", 5, "s1");
    expect(cache.has("s0")).toBe(false);
    expect(cache.has("s1")).toBe(true);
  });

  test("evicts correctly when activeKey is not in the cache", () => {
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5, "ghost-session");
    // "ghost-session" is not in the cache so it doesn't affect selection.
    expect(cache.has("s0")).toBe(false); // s0 is still evicted as LRU
    expect(cache.size).toBe(4);
  });

  test("no eviction is skipped when activeKey is null", () => {
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5, null);
    expect(cache.size).toBe(4);
    expect(cache.has("s0")).toBe(false);
  });

  test("no eviction is skipped when activeKey is undefined", () => {
    const cache = makeCache(5);
    evictLruIfNeeded(cache, "new-session", 5, undefined);
    expect(cache.size).toBe(4);
    expect(cache.has("s0")).toBe(false);
  });

  test("no entry is evicted if all entries are the activeKey (single-entry cache at capacity)", () => {
    // Edge case: only one entry in cache and it is the active session.
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("only", makeEntry(1000));
    evictLruIfNeeded(cache, "new-session", 1, "only");
    // There is no non-active candidate, so nothing is evicted.
    expect(cache.size).toBe(1);
    expect(cache.has("only")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("evictLruIfNeeded — edge cases", () => {
  test("empty cache: no-op, no error", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    expect(() => evictLruIfNeeded(cache, "new-session", 0)).not.toThrow();
    expect(cache.size).toBe(0);
  });

  test("maxSize of 1 evicts the only existing entry when a new key is inserted", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("old", makeEntry(1000));
    evictLruIfNeeded(cache, "fresh", 1);
    expect(cache.has("old")).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("works correctly with the default MAX_SESSION_UI_CACHE_SIZE of 50", () => {
    const cache = makeCache(50);
    evictLruIfNeeded(cache, "s50"); // uses default maxSize
    expect(cache.size).toBe(49);
    expect(cache.has("s0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// touchSessionCache
// ---------------------------------------------------------------------------

describe("touchSessionCache", () => {
  test("updates lastAccessed for an existing entry", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("x", makeEntry(1000));

    touchSessionCache(cache, "x", 9999);
    expect(cache.get("x")?.lastAccessed).toBe(9999);
  });

  test("does not mutate other fields of the entry", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    const entry = { ...makeEntry(1000), sessionName: "My Session", agentActive: true };
    cache.set("x", entry);

    touchSessionCache(cache, "x", 5000);
    const updated = cache.get("x")!;
    expect(updated.sessionName).toBe("My Session");
    expect(updated.agentActive).toBe(true);
    expect(updated.lastAccessed).toBe(5000);
  });

  test("is a no-op when the session is not in the cache", () => {
    const cache = makeCache(3);
    const sizeBefore = cache.size;
    expect(() => touchSessionCache(cache, "ghost", 9999)).not.toThrow();
    expect(cache.size).toBe(sizeBefore);
    expect(cache.has("ghost")).toBe(false);
  });

  test("after touching the LRU entry it is no longer the eviction candidate", () => {
    // s0 starts as oldest (1000). After touch it becomes newest.
    const cache = makeCache(5);
    touchSessionCache(cache, "s0", 99999);

    evictLruIfNeeded(cache, "new-session", 5);

    // s0 is now the MRU — s1 (lastAccessed=2000) should be evicted instead.
    expect(cache.has("s0")).toBe(true);
    expect(cache.has("s1")).toBe(false);
  });

  test("uses Date.now() by default (smoke test — just checks it does not throw)", () => {
    const cache = new Map<string, SessionUiCacheEntry>();
    cache.set("y", makeEntry(1000));
    expect(() => touchSessionCache(cache, "y")).not.toThrow();
    // lastAccessed should have been updated to a reasonable epoch value.
    expect((cache.get("y")?.lastAccessed ?? 0)).toBeGreaterThan(1000);
  });
});
