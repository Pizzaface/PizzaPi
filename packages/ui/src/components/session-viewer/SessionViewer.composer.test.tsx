/**
 * Regression tests for the composer clear-on-send behavior in SessionViewer.
 *
 * The text input should clear immediately when the user submits a message,
 * rather than waiting for the async send round-trip. If the send fails, the
 * draft is restored only when the composer hasn't been edited in the meantime.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).File = win.File;
(globalThis as any).FileReader = win.FileReader;
(globalThis as any).FormData = win.FormData;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).requestAnimationFrame = () => 0;
(globalThis as any).cancelAnimationFrame = () => {};
/* eslint-enable @typescript-eslint/no-explicit-any */

const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const React = (await import("react")).default;
const { TooltipProvider } = await import("@/components/ui/tooltip");
const atMention = await import("../session-viewer/at-mention-handlers");
const { SessionViewer } = await import("../SessionViewer");

afterEach(cleanup);

function setup(options: { onSendInput?: any; runnerId?: string; runnerInfo?: any }) {
  const view = render(
    React.createElement(
      TooltipProvider,
      {},
      React.createElement(SessionViewer, {
        sessionId: "sess-1",
        messages: [],
        viewerStatus: "Connected",
        onSendInput: options.onSendInput,
        runnerId: options.runnerId,
        runnerInfo: options.runnerInfo,
      } as any),
    ),
  );
  return { view };
}

function getComposer(view: any) {
  const textarea = view.container.querySelector(
    'textarea[aria-label="Message"]',
  ) as HTMLTextAreaElement;
  const form = view.container.querySelector("form") as HTMLFormElement;
  return { textarea, form };
}

function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    textarea.value = value;
    fireEvent.input(textarea);
  });
}

describe("SessionViewer composer clear-on-send", () => {
  test("clears the textarea immediately on submit", async () => {
    const { view } = setup({
      onSendInput: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return true;
      },
    });

    const { textarea, form } = getComposer(view);
    typeIntoTextarea(textarea, "hello");
    expect(textarea.value).toBe("hello");

    await act(async () => {
      fireEvent.submit(form);
    });

    // Cleared immediately, before the async send resolves.
    expect(textarea.value).toBe("");
  });

  test("restores the textarea on send failure", async () => {
    const { view } = setup({
      onSendInput: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return false;
      },
    });

    const { textarea, form } = getComposer(view);
    typeIntoTextarea(textarea, "hello");

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(textarea.value).toBe("hello"));
  });

  test("does not clobber new user typing when restoring on failure", async () => {
    const { view } = setup({
      onSendInput: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return false;
      },
    });

    const { textarea, form } = getComposer(view);
    typeIntoTextarea(textarea, "hello");

    await act(async () => {
      fireEvent.submit(form);
      // While the send is in flight, the user types something new.
      typeIntoTextarea(textarea, "world");
    });

    await waitFor(() => expect(textarea.value).toBe("world"));
  });
});

describe("scanAtMentionTrigger (composer @-mention alongside slash commands)", () => {
  const scan = (text: string) => atMention.scanAtMentionTrigger(text, text.length);

  test("detects @ after a skill command", () => {
    expect(scan("/skill:demo @")).toEqual({ triggerOffset: 12, query: "" });
  });

  test("detects @ query mid-message after a skill command", () => {
    expect(scan("/skill:demo @src")).toEqual({ triggerOffset: 12, query: "src" });
  });

  test("inactive when mention already completed with a space", () => {
    expect(scan("/skill:demo @src/ foo")).toEqual({ triggerOffset: null, query: "" });
  });

  test("plain slash command without @ is inactive", () => {
    expect(scan("/skill:demo some args")).toEqual({ triggerOffset: null, query: "" });
  });

  test("@ mid-word does not trigger", () => {
    expect(scan("email me@test.com")).toEqual({ triggerOffset: null, query: "" });
  });

  test("@ at start of message triggers", () => {
    expect(scan("@")).toEqual({ triggerOffset: 0, query: "" });
  });
});
