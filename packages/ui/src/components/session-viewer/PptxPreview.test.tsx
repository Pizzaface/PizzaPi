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
    static throwOn: number | null = null;
    async load() {
      loaded++;
      this.slideCount = 3;
    }
    async renderSlide(index: number) {
      rendered.push(index);
      const ctor = this.constructor as typeof PptxRenderer & { throwOn: number | null };
      if (ctor.throwOn === index) {
        throw new Error(`render slide ${index} failed`);
      }
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
const { default: PptxPreview } = await import("./PptxPreview");
const { PptxRenderer } = await import("pptx-browser");

afterEach(() => {
  cleanup();
  (PptxRenderer as unknown as { throwOn: number | null }).throwOn = null;
});

describe("PptxPreview", () => {
  test("loads the deck and shows a slide navigator", async () => {
    const { getByText } = render(<PptxPreview content="AAAA" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());
    expect(loaded).toBeGreaterThan(0);
  });

  test("navigation controls do not submit a containing form", async () => {
    let submitted = false;
    const { getByText, getByLabelText } = render(
      <form onSubmit={(event) => { event.preventDefault(); submitted = true; }}>
        <PptxPreview content="FORM" />
      </form>,
    );
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());

    fireEvent.click(getByLabelText("Next slide"));
    await waitFor(() => expect(getByText("2 / 3")).toBeDefined());
    expect(submitted).toBe(false);
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

  test("disables navigation while a slide is rendering", async () => {
    const { getByText, getByLabelText } = render(<PptxPreview content="CCCC" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());

    const next = getByLabelText("Next slide") as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    fireEvent.click(next);
    // Immediately after click, while renderSlide is pending, the button should be disabled.
    await waitFor(() => expect(next.disabled).toBe(true));

    // Once the render resolves the counter updates and the button is re-enabled.
    await waitFor(() => expect(getByText("2 / 3")).toBeDefined());
    expect(next.disabled).toBe(false);
  });

  test("shows an error and keeps the current slide when navigation render fails", async () => {
    (PptxRenderer as unknown as { throwOn: number | null }).throwOn = 1;
    const { getByText, getByLabelText } = render(<PptxPreview content="DDDD" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());

    fireEvent.click(getByLabelText("Next slide"));
    await waitFor(() => expect(getByText(/render slide 1 failed/)).toBeDefined());

    // Counter should not advance.
    expect(getByText("1 / 3")).toBeDefined();
  });

  test("destroys the renderer on unmount", () => {
    const before = destroyed;
    const { unmount } = render(<PptxPreview content="CCCC" />);
    unmount();
    expect(destroyed).toBeGreaterThan(before);
  });
});
