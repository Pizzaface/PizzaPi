import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { renderGroupedToolExecution, renderReadToolResult } from "./tool-rendering";

function findImage(node: React.ReactNode): React.ReactElement<React.ImgHTMLAttributes<HTMLImageElement>> | null {
  const all = findAllImages(node);
  return all[0] ?? null;
}

function findAllImages(node: React.ReactNode): React.ReactElement<React.ImgHTMLAttributes<HTMLImageElement>>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => findAllImages(child));
  }
  if (!React.isValidElement(node)) return [];
  if (node.type === "img") {
    return [node as React.ReactElement<React.ImgHTMLAttributes<HTMLImageElement>>];
  }
  return findAllImages((node.props as { children?: React.ReactNode }).children);
}

afterEach(() => cleanup());

describe("renderReadToolResult", () => {
  test("renders an image extracted to an attachment URL", () => {
    const image = findImage(renderReadToolResult([
      {
        type: "image",
        mimeType: "image/png",
        source: {
          type: "url",
          url: "/api/attachments/image-id",
          extracted: true,
          originalSizeBytes: 12_345,
        },
      },
    ]));

    expect(image?.props.src).toBe("/api/attachments/image-id");
    expect(image?.props.loading).toBe("lazy");
  });

  test("does not render unsafe extracted image URLs", () => {
    const image = findImage(renderReadToolResult([
      {
        type: "image",
        mimeType: "image/png",
        source: { type: "url", url: "javascript:alert(1)" },
      },
    ]));

    expect(image).toBeNull();
  });

  test("collapses a duplicate inline-data image block to a single render", () => {
    const images = findAllImages(renderReadToolResult([
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ]));

    expect(images).toHaveLength(1);
  });

  test("collapses a duplicate extracted-URL image block to a single render", () => {
    const images = findAllImages(renderReadToolResult([
      { type: "image", mimeType: "image/png", source: { type: "url", url: "/api/attachments/dup-id" } },
      { type: "image", mimeType: "image/png", source: { type: "url", url: "/api/attachments/dup-id" } },
    ]));

    expect(images).toHaveLength(1);
  });

  test("renders genuinely distinct images separately", () => {
    const images = findAllImages(renderReadToolResult([
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "image", mimeType: "image/png", data: "BBBB" },
    ]));

    expect(images).toHaveLength(2);
  });
});

describe("renderGroupedToolExecution", () => {
  test("renders Pi 1.0 nested tool call summaries on the parent card", () => {
    const node = renderGroupedToolExecution(
      "tc1",
      "codemode",
      { script: "await tools.read({ path: 'x' })" },
      [{ type: "text", text: "done" }],
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        complete: false,
        calls: [{ id: "tc1/1", name: "read", status: "ok", durationMs: 9 }],
      },
    );

    const view = render(<>{node}</>);
    expect(view.getByText("Nested tool calls · 1 (truncated)")).toBeTruthy();
    expect(view.getByText("tc1/1")).toBeTruthy();
    expect(view.getByText("read")).toBeTruthy();
    expect(view.getByText("ok")).toBeTruthy();
  });
});
