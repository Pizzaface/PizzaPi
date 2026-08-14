import { describe, expect, test } from "bun:test";
import { countOAuthServers, resolveOAuthCallbackPort, type McpConfig } from "./registry.js";

describe("OAuth callback port allocation", () => {
  test("single OAuth server honors the configured global port", () => {
    expect(resolveOAuthCallbackPort(undefined, 4567, 1)).toBe(4567);
    expect(countOAuthServers({
      oauthClientId: "client",
      mcp: { servers: [{ name: "one", transport: "streamable", url: "https://one.test/mcp" }] },
    }, new Set())).toBe(1);
  });

  test("multiple OAuth servers without per-server ports use ephemeral ports", () => {
    expect(resolveOAuthCallbackPort(undefined, 4567, 2)).toBe(0);
    expect(countOAuthServers({
      mcpServers: {
        one: { url: "https://one.test/mcp", transport: "streamable", oauthClientId: "one" },
        two: { url: "https://two.test/mcp", transport: "streamable", oauthClientId: "two" },
      },
    }, new Set())).toBe(2);
  });

  test("explicit per-server ports are always honored", () => {
    expect(resolveOAuthCallbackPort(9876, 4567, 2)).toBe(9876);
    expect(resolveOAuthCallbackPort(9876, undefined, 1)).toBe(9876);
  });

  test("non-OAuth streamable servers do not inflate the OAuth count", () => {
    const config: McpConfig = {
      mcpServers: {
        oauth: { url: "https://oauth.test/mcp", transport: "streamable", oauthClientId: "client" },
        bearer: { url: "https://bearer.test/mcp", transport: "streamable", headers: { Authorization: "Bearer token" } },
      },
    };
    expect(countOAuthServers(config, new Set())).toBe(1);
    expect(resolveOAuthCallbackPort(undefined, 4567, countOAuthServers(config, new Set()))).toBe(4567);
  });
});
