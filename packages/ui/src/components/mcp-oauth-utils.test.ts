/**
 * Tests for MCP OAuth URL parsing logic.
 */

import { describe, test, expect } from "bun:test";
import { extractCodeFromUrl, extractOAuthParams } from "./mcp-oauth-utils";

describe("extractCodeFromUrl", () => {
  test("extracts code from full localhost callback URL", () => {
    const url = "http://localhost:1/callback?code=abc123&state=xyz";
    expect(extractCodeFromUrl(url)).toBe("abc123");
  });

  test("extracts code from localhost URL with different port", () => {
    const url = "http://localhost:53692/callback?code=mycode&state=mystate";
    expect(extractCodeFromUrl(url)).toBe("mycode");
  });

  test("extracts code from 127.0.0.1 URL", () => {
    const url = "http://127.0.0.1:8080/callback?code=test_code&state=test_state";
    expect(extractCodeFromUrl(url)).toBe("test_code");
  });

  test("extracts code from URL with extra query params", () => {
    const url = "http://localhost:1/callback?code=abc&state=xyz&extra=foo";
    expect(extractCodeFromUrl(url)).toBe("abc");
  });

  test("extracts code from query string only", () => {
    expect(extractCodeFromUrl("?code=abc123&state=xyz")).toBe("abc123");
  });

  test("extracts code from bare query params (no ?)", () => {
    expect(extractCodeFromUrl("code=abc123&state=xyz")).toBe("abc123");
  });

  test("returns null for empty input", () => {
    expect(extractCodeFromUrl("")).toBeNull();
    expect(extractCodeFromUrl("   ")).toBeNull();
  });

  test("returns null for URL without code param", () => {
    expect(extractCodeFromUrl("http://localhost:1/callback?state=xyz")).toBeNull();
  });

  test("returns null for random text", () => {
    expect(extractCodeFromUrl("not a url at all")).toBeNull();
  });

  test("handles URL-encoded code values", () => {
    const url = "http://localhost:1/callback?code=abc%20def&state=xyz";
    expect(extractCodeFromUrl(url)).toBe("abc def");
  });

  test("handles whitespace around input", () => {
    const url = "  http://localhost:1/callback?code=abc123&state=xyz  ";
    expect(extractCodeFromUrl(url)).toBe("abc123");
  });

  test("extracts code from https URL (relay mode)", () => {
    const url = "https://pizza.example.com/api/mcp-oauth-callback?code=relay_code&state=encoded_state";
    expect(extractCodeFromUrl(url)).toBe("relay_code");
  });
});

describe("extractOAuthParams", () => {
  test("extracts both code and state from full URL", () => {
    const url = "http://localhost:1/callback?code=abc123&state=xyz789";
    const result = extractOAuthParams(url);
    expect(result.code).toBe("abc123");
    expect(result.state).toBe("xyz789");
  });

  test("returns null state when not present", () => {
    const url = "http://localhost:1/callback?code=abc123";
    const result = extractOAuthParams(url);
    expect(result.code).toBe("abc123");
    expect(result.state).toBeNull();
  });

  test("extracts from query string", () => {
    const result = extractOAuthParams("?code=abc&state=def");
    expect(result.code).toBe("abc");
    expect(result.state).toBe("def");
  });

  test("returns nulls for empty input", () => {
    const result = extractOAuthParams("");
    expect(result.code).toBeNull();
    expect(result.state).toBeNull();
  });
});

describe("auth URL safety", () => {
  // Re-implement isSafeAuthUrl for testing (it's not exported from the component)
  function isSafeAuthUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  test("allows https URLs", () => {
    expect(isSafeAuthUrl("https://figma.com/oauth/authorize?foo=bar")).toBe(true);
  });

  test("allows http URLs", () => {
    expect(isSafeAuthUrl("http://localhost:1/callback")).toBe(true);
  });

  test("blocks javascript: URLs", () => {
    expect(isSafeAuthUrl("javascript:alert(1)")).toBe(false);
  });

  test("blocks data: URLs", () => {
    expect(isSafeAuthUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  test("blocks empty string", () => {
    expect(isSafeAuthUrl("")).toBe(false);
  });

  test("blocks malformed URLs", () => {
    expect(isSafeAuthUrl("not a url")).toBe(false);
  });
});
