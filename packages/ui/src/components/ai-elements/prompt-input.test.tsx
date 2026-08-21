import { describe, expect, test } from "bun:test";

const { shouldClearPromptInputAfterSubmit } = await import("./prompt-input");

describe("PromptInput submit", () => {
  test("preserves attachments and blob URLs when a send fails", () => {
    expect(shouldClearPromptInputAfterSubmit(false)).toBe(false);
  });

  test("clears attachments and blob URLs after a successful send", () => {
    expect(shouldClearPromptInputAfterSubmit(true)).toBe(true);
  });
});
