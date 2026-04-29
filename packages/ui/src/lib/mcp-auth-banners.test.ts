import { describe, expect, test } from "bun:test";
import { removeMessagesByStableKey, replaceMessageByStableKey } from "./mcp-auth-banners";

const baseMessages = [
  { key: "m1", role: "user", content: "hi" },
  { key: "mcp_auth:github", role: "system", content: "old" },
  { key: "m2", role: "assistant", content: "hello" },
];

describe("replaceMessageByStableKey", () => {
  test("replaces an existing auth banner in place", () => {
    const next = replaceMessageByStableKey(baseMessages, "mcp_auth:github", {
      key: "mcp_auth:github",
      role: "system",
      content: "new",
    });

    expect(next).toEqual([
      { key: "m1", role: "user", content: "hi" },
      { key: "mcp_auth:github", role: "system", content: "new" },
      { key: "m2", role: "assistant", content: "hello" },
    ]);
  });

  test("appends the auth banner when it does not exist yet", () => {
    const next = replaceMessageByStableKey(baseMessages.filter((m) => m.key !== "mcp_auth:github"), "mcp_auth:github", {
      key: "mcp_auth:github",
      role: "system",
      content: "new",
    });

    expect(next).toEqual([
      { key: "m1", role: "user", content: "hi" },
      { key: "m2", role: "assistant", content: "hello" },
      { key: "mcp_auth:github", role: "system", content: "new" },
    ]);
  });
});

describe("removeMessagesByStableKey", () => {
  test("removes exact and prefixed auth banner keys", () => {
    const next = removeMessagesByStableKey([
      ...baseMessages,
      { key: "mcp_auth:github:retry", role: "system", content: "retry" },
    ], "mcp_auth:github");

    expect(next).toEqual([
      { key: "m1", role: "user", content: "hi" },
      { key: "m2", role: "assistant", content: "hello" },
    ]);
  });
});
