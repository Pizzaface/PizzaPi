/**
 * Tests for PptxPreview — wiring around the pptx-browser renderer.
 *
 * Canvas rendering can't run under happy-dom, so pptx-browser is mocked with a
 * fake renderer; this verifies the slide navigator and lifecycle, not pixels.
 */
import { afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";

let loaded = 0;
let destroyed = 0;
const rendered: number[] = [];

mock.module("pptx-browser", () => ({
  PptxRenderer: class {
    slideCount = 0;
    async load() {
      loaded++;
      this.slideCount = 3;
    }
    async renderSlide(index: number) {
      rendered.push(index);
    }
    destroy() {
      destroyed++;
    }
  },
}));

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;
(globalThis as any).atob = (b64: string) => Buffer.from(b64, "base64").toString("binary");

const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
const { default: PptxPreview } = await import("./PptxPreview");

afterEach(() => cleanup());

describe("PptxPreview", () => {
  test("loads the deck and shows a slide navigator", async () => {
    const { getByText } = render(<PptxPreview content="AAAA" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());
    expect(loaded).toBeGreaterThan(0);
  });

  test("next/prev navigate and render the target slide", async () => {
    const before = rendered.length;
    const { getByText, getByLabelText } = render(<PptxPreview content="BBBB" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());

    fireEvent.click(getByLabelText("Next slide"));
    await waitFor(() => expect(getByText("2 / 3")).toBeDefined());
    // Rendered slide index 1 at least once after nav.
    expect(rendered.slice(before)).toContain(1);
  });

  test("destroys the renderer on unmount", () => {
    const before = destroyed;
    const { unmount } = render(<PptxPreview content="CCCC" />);
    unmount();
    expect(destroyed).toBeGreaterThan(before);
  });
});
