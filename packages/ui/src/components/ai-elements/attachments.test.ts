import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./attachments.tsx", import.meta.url)).text();

describe("AttachmentRemove", () => {
  test("reveals inline and grid remove controls on keyboard focus", () => {
    const gridClasses = source.match(
      /variant === "grid" && \[([\s\S]*?)\],\n        variant === "inline"/,
    )?.[1];
    const inlineClasses = source.match(
      /variant === "inline" && \[([\s\S]*?)\],\n        variant === "list"/,
    )?.[1];

    expect(gridClasses).toContain("focus-visible:opacity-100");
    expect(inlineClasses).toContain("focus-visible:opacity-100");
  });
});
