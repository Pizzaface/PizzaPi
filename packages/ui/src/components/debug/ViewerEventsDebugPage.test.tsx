import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ViewerEventsDebugPage } from "./ViewerEventsDebugPage";
import { clearViewerDebugEvents, recordViewerDebugEvent } from "../../lib/viewer-debug-events";

const win = new Window({ url: "http://localhost/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;

afterEach(() => {
  clearViewerDebugEvents();
  cleanup();
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
});

describe("ViewerEventsDebugPage", () => {
  test("renders a rolling list of recorded debug events", () => {
    act(() => {
      recordViewerDebugEvent({ source: "viewer", type: "service_announce", payload: { sigilDefs: [{ type: "pr" }] } });
      recordViewerDebugEvent({ source: "sigil", type: "resolve_error", payload: { type: "pr", id: "123", error: "404" } });
    });

    const { container } = render(<ViewerEventsDebugPage />);

    expect(container.textContent).toContain("Viewer Event Debugger");
    expect(container.textContent).toContain("service_announce");
    expect(container.textContent).toContain("resolve_error");
    expect(container.textContent).toContain('"type": "pr"');
  });

  test("supports embedded split-view rendering", () => {
    const { container } = render(<ViewerEventsDebugPage embedded />);

    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.className).toContain("flex");
    expect(root?.className).toContain("h-full");
    expect(container.textContent).toContain("No events captured yet.");
  });

  test("renders collapsible payloads and copies JSON", async () => {
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    act(() => {
      recordViewerDebugEvent({ source: "sigil", type: "resolve_error", payload: { type: "pr", id: "123", error: "500" } });
    });

    const { container } = render(<ViewerEventsDebugPage />);
    const details = container.getElementsByTagName("details")[0] ?? null;
    expect(details?.hasAttribute("open")).toBe(true);

    const copyButton = Array.from(container.getElementsByTagName("button")).find((el) => el.textContent === "Copy JSON");
    expect(copyButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(copyButton!);
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ type: "pr", id: "123", error: "500" }, null, 2));
    const copiedButton = Array.from(container.getElementsByTagName("button")).find((el) => el.textContent === "Copied");
    expect(copiedButton).toBeTruthy();
  });
});
