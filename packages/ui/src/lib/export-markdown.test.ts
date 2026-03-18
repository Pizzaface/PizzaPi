import { describe, test, expect } from "bun:test";
import { exportToMarkdown } from "./export-markdown";
import type { RelayMessage } from "@/components/session-viewer/types";

/** Helper to create a minimal RelayMessage. */
function msg(overrides: Partial<RelayMessage> & { role: string }): RelayMessage {
  return { key: "test-" + Math.random().toString(36).slice(2, 8), ...overrides };
}

describe("exportToMarkdown", () => {
  test("user message renders with heading and content", () => {
    const md = exportToMarkdown([msg({ role: "user", content: "Hello world" })]);
    expect(md).toContain("## 🧑 User");
    expect(md).toContain("Hello world");
  });

  test("assistant message renders with heading and content", () => {
    const md = exportToMarkdown([msg({ role: "assistant", content: "Hi there!" })]);
    expect(md).toContain("## 🤖 Assistant");
    expect(md).toContain("Hi there!");
  });

  test("assistant message with thinking renders details block", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: "The answer is 42",
        thinking: "Let me think about this...",
        thinkingDuration: 3,
      }),
    ]);
    expect(md).toContain("<details>");
    expect(md).toContain("💭 Thinking (3s)");
    expect(md).toContain("Let me think about this...");
    expect(md).toContain("</details>");
    expect(md).toContain("The answer is 42");
  });

  test("assistant thinking without duration omits ms", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: "result",
        thinking: "hmm",
      }),
    ]);
    expect(md).toContain("💭 Thinking</summary>");
    expect(md).not.toContain("ms");
  });

  test("tool call renders with name, input, and output", () => {
    const md = exportToMarkdown([
      msg({
        role: "tool",
        toolName: "Read",
        toolInput: { path: "src/app.tsx" },
        content: "file contents here",
      }),
    ]);
    expect(md).toContain("### 🔧 Read");
    expect(md).toContain("**Input:**");
    expect(md).toContain('"path": "src/app.tsx"');
    expect(md).toContain("**Output:**");
    expect(md).toContain("file contents here");
  });

  test("toolResult renders same as tool", () => {
    const md = exportToMarkdown([
      msg({
        role: "toolResult",
        toolName: "Bash",
        toolInput: { command: "ls" },
        content: "file1\nfile2",
      }),
    ]);
    expect(md).toContain("### 🔧 Bash");
    expect(md).toContain("**Input:**");
    expect(md).toContain("**Output:**");
  });

  test("tool output over 5000 chars is truncated", () => {
    const longOutput = "x".repeat(6000);
    const md = exportToMarkdown([
      msg({
        role: "tool",
        toolName: "Read",
        toolInput: { path: "big.txt" },
        content: longOutput,
      }),
    ]);
    expect(md).toContain("[truncated — 6000 chars total]");
    expect(md).not.toContain("x".repeat(6000));
  });

  test("compaction summary renders as blockquote with token count", () => {
    const md = exportToMarkdown([
      msg({
        role: "compactionSummary",
        summary: "Session context was compacted",
        tokensBefore: 50000,
      }),
    ]);
    expect(md).toContain("📦 **Context compacted** (50,000 tokens)");
    expect(md).toContain("Session context was compacted");
    expect(md).toContain("---");
  });

  test("branch summary renders as blockquote", () => {
    const md = exportToMarkdown([
      msg({
        role: "branchSummary",
        summary: "Branched from main session",
      }),
    ]);
    expect(md).toContain("🌿 **Branch summary**");
    expect(md).toContain("Branched from main session");
  });

  test("sub-agent conversation renders sent and received turns", () => {
    const md = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          { type: "sent", sessionId: "abc123", message: "Do the thing", isStreaming: false, isError: false },
          { type: "received", fromSessionId: "abc123", message: "Done!", isStreaming: false },
        ],
      }),
    ]);
    expect(md).toContain("#### 🤝 Sub-agent Conversation");
    expect(md).toContain("**→ Sent** to abc123");
    expect(md).toContain("Do the thing");
    expect(md).toContain("**← Received** from abc123");
    expect(md).toContain("Done!");
  });

  test("sub-agent waiting/timed-out/cancelled states", () => {
    const md = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          { type: "waiting", isTimedOut: false, isCancelled: false, isStreaming: true },
        ],
      }),
    ]);
    expect(md).toContain("**⏳ Waiting** for response...");

    const md2 = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          { type: "waiting", isTimedOut: true, isCancelled: false, isStreaming: false },
        ],
      }),
    ]);
    expect(md2).toContain("**⏳ Timed out**");

    const md3 = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          { type: "waiting", isTimedOut: false, isCancelled: true, isStreaming: false },
        ],
      }),
    ]);
    expect(md3).toContain("**❌ Cancelled**");
  });

  test("error message renders as warning blockquote", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: "Trying to help...",
        stopReason: "error",
        errorMessage: "Rate limit exceeded",
      }),
    ]);
    expect(md).toContain("> ⚠️ **Error:** Rate limit exceeded");
  });

  test("mixed conversation produces correct ordering", () => {
    const md = exportToMarkdown([
      msg({ role: "user", content: "Fix the bug" }),
      msg({ role: "assistant", content: "Let me look at that" }),
      msg({ role: "tool", toolName: "Read", toolInput: { path: "bug.ts" }, content: "buggy code" }),
      msg({ role: "assistant", content: "Found it! Here's the fix." }),
    ]);
    const userIdx = md.indexOf("🧑 User");
    const assist1Idx = md.indexOf("Let me look at that");
    const toolIdx = md.indexOf("🔧 Read");
    const assist2Idx = md.indexOf("Found it!");
    expect(userIdx).toBeLessThan(assist1Idx);
    expect(assist1Idx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(assist2Idx);
  });

  test("array content (Anthropic blocks) extracts text", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      }),
    ]);
    expect(md).toContain("First part");
    expect(md).toContain("Second part");
    // Should NOT contain raw JSON
    expect(md).not.toContain('"type"');
  });

  test("object content is JSON-stringified in code block", () => {
    const md = exportToMarkdown([
      msg({ role: "assistant", content: { foo: "bar", count: 42 } }),
    ]);
    expect(md).toContain("```json");
    expect(md).toContain('"foo": "bar"');
  });

  test("empty/undefined content messages are skipped", () => {
    const md = exportToMarkdown([
      msg({ role: "user", content: undefined }),
      msg({ role: "assistant", content: "" }),
      msg({ role: "user", content: "Real message" }),
    ]);
    expect(md).not.toContain("## 🧑 User\n\n\n");
    expect(md).toContain("Real message");
    // Only one User heading (the empty ones were skipped)
    expect(md.match(/## 🧑 User/g)?.length).toBe(1);
  });

  test("system messages render as blockquotes", () => {
    const md = exportToMarkdown([
      msg({ role: "system", content: "You are a helpful assistant" }),
    ]);
    expect(md).toContain("> **System:**");
    expect(md).toContain("You are a helpful assistant");
  });

  test("tool with missing name shows Unknown tool", () => {
    const md = exportToMarkdown([
      msg({ role: "tool", toolInput: { x: 1 }, content: "result" }),
    ]);
    expect(md).toContain("### 🔧 Unknown tool");
  });

  test("check_messages sub-agent turn with messages", () => {
    const md = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          {
            type: "check",
            messages: [{ fromSessionId: "s1", message: "hello" }],
            isEmpty: false,
            isStreaming: false,
          },
        ],
      }),
    ]);
    expect(md).toContain("**← Message** from s1");
    expect(md).toContain("hello");
  });

  test("check_messages sub-agent turn empty", () => {
    const md = exportToMarkdown([
      msg({
        role: "subAgentConversation",
        subAgentTurns: [
          { type: "check", messages: [], isEmpty: true, isStreaming: false },
        ],
      }),
    ]);
    expect(md).toContain("**📭 No messages**");
  });

  test("inline thinking blocks in content array are rendered", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      }),
    ]);
    expect(md).toContain("<details>");
    expect(md).toContain("💭 Thinking");
    expect(md).toContain("Let me reason about this...");
    expect(md).toContain("</details>");
    expect(md).toContain("Here is my answer.");
  });

  test("web search query metadata is preserved", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "",
            _serverToolUse: { id: "tu_1", name: "web_search", input: { query: "bun test runner" } },
          },
          { type: "text", text: "Based on my search..." },
        ],
      }),
    ]);
    expect(md).toContain("🔍 **Web search:** bun test runner");
    expect(md).toContain("Based on my search...");
  });

  test("web search results metadata is preserved", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "",
            _webSearchResult: {
              tool_use_id: "tu_1",
              content: [
                { type: "web_search_result", title: "Bun Docs", url: "https://bun.sh/docs" },
                { type: "web_search_result", title: "Bun Test", url: "https://bun.sh/docs/test" },
              ],
            },
          },
        ],
      }),
    ]);
    expect(md).toContain("📎 **Search results:**");
    expect(md).toContain("[Bun Docs](https://bun.sh/docs)");
    expect(md).toContain("[Bun Test](https://bun.sh/docs/test)");
  });

  test("tool output with Anthropic content blocks extracts text", () => {
    const md = exportToMarkdown([
      msg({
        role: "tool",
        toolName: "spawn_session",
        toolInput: { prompt: "do something" },
        content: [
          { type: "text", text: "Session spawned successfully." },
          { type: "text", text: "Session ID: abc-123" },
        ],
      }),
    ]);
    expect(md).toContain("Session spawned successfully.");
    expect(md).toContain("Session ID: abc-123");
    // Should NOT contain raw JSON
    expect(md).not.toContain('"type"');
  });

  test("image blocks render placeholder or URL", () => {
    const md = exportToMarkdown([
      msg({
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
        ],
      }),
    ]);
    expect(md).toContain("What's in this image?");
    expect(md).toContain("🖼️ *[Image attachment]*");
  });

  test("image blocks with URL render as markdown image", () => {
    const md = exportToMarkdown([
      msg({
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/img.png" } },
        ],
      }),
    ]);
    expect(md).toContain("![image](https://example.com/img.png)");
  });

  test("web search results escape special markdown chars in title/url", () => {
    const md = exportToMarkdown([
      msg({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "",
            _webSearchResult: {
              tool_use_id: "tu_1",
              content: [
                { type: "web_search_result", title: "Title with [brackets]", url: "https://example.com/path_(1)" },
              ],
            },
          },
        ],
      }),
    ]);
    expect(md).toContain("\\[brackets\\]");
    expect(md).toContain("path_\\(1\\)");
  });

  test("output ends with trailing newline", () => {
    const md = exportToMarkdown([msg({ role: "user", content: "hi" })]);
    expect(md.endsWith("\n")).toBe(true);
  });
});
