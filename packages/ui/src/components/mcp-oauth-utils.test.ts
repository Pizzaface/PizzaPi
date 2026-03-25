/**
 * Tests for MCP OAuth URL parsing logic.
 */

import { describe, test, expect } from "bun:test";
import { extractCodeFromUrl } from "./mcp-oauth-utils";

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
