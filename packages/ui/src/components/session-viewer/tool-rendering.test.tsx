import { describe, expect, test } from "bun:test";
import React from "react";
import { renderReadToolResult } from "./tool-rendering";

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
