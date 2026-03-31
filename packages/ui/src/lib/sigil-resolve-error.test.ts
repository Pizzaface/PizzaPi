import { describe, expect, test } from "bun:test";
import { buildSigilResolveFailure, formatSigilResolveError } from "./sigil-resolve-error";

describe("formatSigilResolveError", () => {
  test("includes JSON error payloads for non-ok responses", async () => {
    const res = new Response(JSON.stringify({ error: "Godmother MCP bridge unavailable" }), {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json" },
    });

    await expect(formatSigilResolveError(res)).resolves.toBe("500 Internal Server Error — Godmother MCP bridge unavailable");
  });

  test("marks 500s as retryable and preserves the parsed message", async () => {
    const res = new Response(JSON.stringify({ error: "Runner reconnecting" }), {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "Content-Type": "application/json" },
    });

    await expect(buildSigilResolveFailure(undefined, res)).resolves.toEqual({
      message: "500 Internal Server Error — Runner reconnecting",
      status: 500,
      retryable: true,
    });
  });
});
