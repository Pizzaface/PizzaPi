import { describe, expect, test } from "bun:test";
import {
  evictOldestIfNeeded,
  getTokensCacheKey,
  MAX_HIGHLIGHTER_CACHE_SIZE,
  MAX_TOKENS_CACHE_SIZE,
} from "./code-block-cache";

// ---------------------------------------------------------------------------
// evictOldestIfNeeded
// ---------------------------------------------------------------------------

describe("evictOldestIfNeeded", () => {
  test("does not evict when map is below capacity", () => {
    const map = new Map<string, number>();
    map.set("a", 1);
    map.set("b", 2);

    evictOldestIfNeeded(map, 3);

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
  });

  test("does not evict when map is empty", () => {
    const map = new Map<string, number>();
    evictOldestIfNeeded(map, 1);
    expect(map.size).toBe(0);
  });

  test("evicts the oldest (first-inserted) entry when at capacity", () => {
    const map = new Map<string, number>([
      ["first", 1],
      ["second", 2],
      ["third", 3],
    ]);

    // Map has 3 entries; maxSize is 3 → evict before adding a 4th
    evictOldestIfNeeded(map, 3);

    expect(map.size).toBe(2);
    expect(map.has("first")).toBe(false); // oldest evicted
    expect(map.has("second")).toBe(true);
    expect(map.has("third")).toBe(true);
  });

  test("evicts the oldest entry when map exceeds capacity", () => {
    const map = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);

    // size(4) >= maxSize(3) → evict "a"
    evictOldestIfNeeded(map, 3);

    expect(map.size).toBe(3);
    expect(map.has("a")).toBe(false);
  });

  test("evicts only one entry per call even when multiple exceed capacity", () => {
    const map = new Map<string, number>([
      ["x", 1],
      ["y", 2],
      ["z", 3],
    ]);

    // maxSize is 1; only one eviction per call
    evictOldestIfNeeded(map, 1);

    expect(map.size).toBe(2); // one removed, two remain
    expect(map.has("x")).toBe(false);
  });

  test("maintains FIFO order across multiple insertions and evictions", () => {
    const maxSize = 3;
    const map = new Map<string, number>();

    // Insert 5 entries one at a time, evicting before each insertion
    for (let i = 1; i <= 5; i++) {
      evictOldestIfNeeded(map, maxSize);
      map.set(`key${i}`, i);
    }

    // After 5 insertions with maxSize=3:
    // After key4: evicted key1 → {key2, key3, key4}  → insert key4 → {key2,key3,key4}
    // After key5: evicted key2 → {key3, key4, key5}
    expect(map.size).toBe(3);
    expect(map.has("key1")).toBe(false);
    expect(map.has("key2")).toBe(false);
    expect(map.has("key3")).toBe(true);
    expect(map.has("key4")).toBe(true);
    expect(map.has("key5")).toBe(true);
  });

  test("works with numeric keys", () => {
    const map = new Map<number, string>([
      [1, "one"],
      [2, "two"],
    ]);

    evictOldestIfNeeded(map, 2);

    expect(map.size).toBe(1);
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache size bounds — constants are present and sensible
// ---------------------------------------------------------------------------

describe("cache size constants", () => {
  test("MAX_TOKENS_CACHE_SIZE is a positive integer", () => {
    expect(typeof MAX_TOKENS_CACHE_SIZE).toBe("number");
    expect(Number.isInteger(MAX_TOKENS_CACHE_SIZE)).toBe(true);
    expect(MAX_TOKENS_CACHE_SIZE).toBeGreaterThan(0);
  });

  test("MAX_HIGHLIGHTER_CACHE_SIZE is a positive integer", () => {
    expect(typeof MAX_HIGHLIGHTER_CACHE_SIZE).toBe("number");
    expect(Number.isInteger(MAX_HIGHLIGHTER_CACHE_SIZE)).toBe(true);
    expect(MAX_HIGHLIGHTER_CACHE_SIZE).toBeGreaterThan(0);
  });

  test("cache cannot grow beyond MAX_TOKENS_CACHE_SIZE", () => {
    const cache = new Map<string, number>();
    const limit = MAX_TOKENS_CACHE_SIZE;

    for (let i = 0; i < limit + 10; i++) {
      evictOldestIfNeeded(cache, limit);
      cache.set(`entry-${i}`, i);
    }

    expect(cache.size).toBeLessThanOrEqual(limit);
  });

  test("cache cannot grow beyond MAX_HIGHLIGHTER_CACHE_SIZE", () => {
    const cache = new Map<string, number>();
    const limit = MAX_HIGHLIGHTER_CACHE_SIZE;

    for (let i = 0; i < limit + 5; i++) {
      evictOldestIfNeeded(cache, limit);
      cache.set(`lang-${i}`, i);
    }

    expect(cache.size).toBeLessThanOrEqual(limit);
  });
});

// ---------------------------------------------------------------------------
// getTokensCacheKey
// ---------------------------------------------------------------------------

describe("getTokensCacheKey", () => {
  test("returns a string", () => {
    expect(typeof getTokensCacheKey("const x = 1;", "typescript")).toBe("string");
  });

  test("includes the language in the key", () => {
    const key = getTokensCacheKey("hello", "python");
    expect(key).toContain("python");
  });

  test("different languages produce different keys for the same code", () => {
    const ts = getTokensCacheKey("const x = 1;", "typescript");
    const js = getTokensCacheKey("const x = 1;", "javascript");
    expect(ts).not.toBe(js);
  });

  test("different code lengths produce different keys", () => {
    const k1 = getTokensCacheKey("abc", "text");
    const k2 = getTokensCacheKey("abcd", "text");
    expect(k1).not.toBe(k2);
  });

  test("same code and language produce the same key (stable/idempotent)", () => {
    const code = "function hello() { return 42; }";
    const k1 = getTokensCacheKey(code, "javascript");
    const k2 = getTokensCacheKey(code, "javascript");
    expect(k1).toBe(k2);
  });

  test("short code (≤100 chars) produces a consistent key", () => {
    const short = "x = 1";
    const key = getTokensCacheKey(short, "python");
    expect(key).toContain(short);
  });

  test("long code key includes first and last 100 chars", () => {
    const prefix = "A".repeat(100);
    const middle = "B".repeat(300);
    const suffix = "C".repeat(100);
    const code = prefix + middle + suffix;

    const key = getTokensCacheKey(code, "text");

    expect(key).toContain(prefix);
    expect(key).toContain(suffix);
    // The middle section is not directly embedded (too long for inclusion)
    // The total length is encoded, so two codes of the same prefix/suffix but
    // different total length still differ.
    expect(key).toContain(String(code.length));
  });

  test("two codes with same prefix/suffix but different length have different keys", () => {
    const prefix = "A".repeat(100);
    const suffix = "Z".repeat(100);
    const code1 = prefix + "X" + suffix;
    const code2 = prefix + "XYZXYZ" + suffix;

    const k1 = getTokensCacheKey(code1, "text");
    const k2 = getTokensCacheKey(code2, "text");

    expect(k1).not.toBe(k2);
  });

  test("empty string produces a stable key", () => {
    const key = getTokensCacheKey("", "text");
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    // Calling it twice is idempotent
    expect(getTokensCacheKey("", "text")).toBe(key);
  });
});
