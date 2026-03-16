import { describe, test, expect } from "bun:test";
import { tryRenderServerToolBlock } from "./server-tools";

describe("tryRenderServerToolBlock", () => {
  test("returns null for plain text blocks", () => {
    const block = { type: "text", text: "Hello world" };
    expect(tryRenderServerToolBlock(block, 0)).toBeNull();
  });

  test("returns a component for _serverToolUse with query", () => {
    const block = {
      type: "text",
      text: "\n🔍 **Web Search:** tech news\n",
      _serverToolUse: {
        id: "tool_123",
        name: "web_search",
        input: { query: "tech news" },
      },
    };
    const result = tryRenderServerToolBlock(block, 0);
    expect(result).not.toBeNull();
  });

  test("returns null for _serverToolUse without query", () => {
    const block = {
      type: "text",
      text: "",
      _serverToolUse: {
        id: "tool_123",
        name: "web_search",
        input: {},
      },
    };
    const result = tryRenderServerToolBlock(block, 0);
    expect(result).toBeNull();
  });

  test("returns a component for _webSearchResult with results", () => {
    const block = {
      type: "text",
      text: "\n📋 **Search Results:**\n- [Example](https://example.com)\n",
      _webSearchResult: {
        tool_use_id: "tool_123",
        content: [
          { type: "web_search_result", title: "Example", url: "https://example.com" },
          { type: "web_search_result", title: "Test", url: "https://test.com" },
        ],
      },
    };
    const result = tryRenderServerToolBlock(block, 0);
    expect(result).not.toBeNull();
  });

  test("returns null for _webSearchResult with empty results", () => {
    const block = {
      type: "text",
      text: "",
      _webSearchResult: {
        tool_use_id: "tool_123",
        content: [],
      },
    };
    const result = tryRenderServerToolBlock(block, 0);
    expect(result).toBeNull();
  });

  test("filters out malformed search results", () => {
    const block = {
      type: "text",
      text: "",
      _webSearchResult: {
        tool_use_id: "tool_123",
        content: [
          { type: "web_search_result", title: "Good", url: "https://good.com" },
          { type: "web_search_result", title: 123, url: "https://bad.com" }, // title not string
          { type: "other_type", title: "Also Bad", url: "https://bad2.com" }, // wrong type
        ],
      },
    };
    // Should still render (one valid result)
    const result = tryRenderServerToolBlock(block, 0);
    expect(result).not.toBeNull();
  });
});
