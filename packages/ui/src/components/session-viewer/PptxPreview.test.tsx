/**
 * Tests for PptxPreview — wiring around the browser-only PPTX renderer.
 *
 * The renderer is mocked because happy-dom cannot lay out real slides; this
 * verifies the slide navigator and lifecycle, not pixels.
 */
import { afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";

let loaded = 0;
let destroyed = 0;
let releaseNavigation: (() => void) | null = null;
const rendered: number[] = [];

mock.module("@aiden0z/pptx-renderer", () => ({
  RECOMMENDED_ZIP_LIMITS: {},
  PptxViewer: class {
    slideCount = 0;
    static throwOn: number | null = null;
    static pauseOn: number | null = null;
    constructor(private container: HTMLElement) {}
    async open() {
      loaded++;
      this.slideCount = 3;
    }
    async renderSlide(index: number) {
      rendered.push(index);
      const ctor = this.constructor as typeof PptxViewer & { throwOn: number | null };
      if (ctor.throwOn === index) {
        throw new Error(`render slide ${index} failed`);
      }
      if ((ctor as typeof PptxViewer & { pauseOn: number | null }).pauseOn === index) {
        await new Promise<void>((resolve) => { releaseNavigation = resolve; });
      }
      this.container.dataset.slide = String(index);
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
const workingAtob = (b64: string) => Buffer.from(b64, "base64").toString("binary");
(globalThis as any).atob = workingAtob;

const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
const { default: PptxPreview } = await import("./PptxPreview");
const { PptxViewer } = await import("@aiden0z/pptx-renderer");

afterEach(() => {
  cleanup();
  (PptxViewer as unknown as { throwOn: number | null; pauseOn: number | null }).throwOn = null;
  (PptxViewer as unknown as { throwOn: number | null; pauseOn: number | null }).pauseOn = null;
  releaseNavigation = null;
  globalThis.atob = workingAtob;
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
    (PptxViewer as unknown as { throwOn: number | null }).throwOn = 1;
    const { getByText, getByLabelText } = render(<PptxPreview content="DDDD" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());

    fireEvent.click(getByLabelText("Next slide"));
    await waitFor(() => expect(getByText(/render slide 1 failed/)).toBeDefined());

    // Counter should not advance and the valid current slide remains visible.
    expect(getByText("1 / 3")).toBeDefined();
    expect(getByLabelText("Rendered slide").classList.contains("invisible")).toBe(false);
  });

  test("reports malformed content without leaking a renderer", async () => {
    const before = destroyed;
    globalThis.atob = () => { throw new Error("bad base64"); };
    const { getByText } = render(<PptxPreview content="invalid" />);
    await waitFor(() => expect(getByText(/bad base64/)).toBeDefined());
    expect(destroyed).toBe(before);
  });

  test("ignores navigation completion from a replaced deck", async () => {
    (PptxViewer as unknown as { pauseOn: number | null }).pauseOn = 1;
    const { getByText, getByLabelText, rerender } = render(<PptxPreview content="OLD" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());
    fireEvent.click(getByLabelText("Next slide"));
    await waitFor(() => expect(releaseNavigation).not.toBeNull());

    rerender(<PptxPreview content="NEW" />);
    await waitFor(() => expect(getByText("1 / 3")).toBeDefined());
    releaseNavigation?.();
    await Promise.resolve();
    expect(getByText("1 / 3")).toBeDefined();
  });

  test("destroys the renderer on unmount", () => {
    const before = destroyed;
    const { unmount } = render(<PptxPreview content="CCCC" />);
    unmount();
    expect(destroyed).toBeGreaterThan(before);
  });
});
