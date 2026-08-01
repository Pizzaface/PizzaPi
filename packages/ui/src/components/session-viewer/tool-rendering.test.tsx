import { describe, expect, test } from "bun:test";
import React from "react";
import { renderReadToolResult } from "./tool-rendering";

function findImage(node: React.ReactNode): React.ReactElement<React.ImgHTMLAttributes<HTMLImageElement>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const image = findImage(child);
      if (image) return image;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (node.type === "img") {
    return node as React.ReactElement<React.ImgHTMLAttributes<HTMLImageElement>>;
  }
  return findImage((node.props as { children?: React.ReactNode }).children);
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
});
