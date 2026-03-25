import { beforeAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));
mock.module("@/components/CombinedPanel", async () => await import("./CombinedPanel"));

const { DockedPanelGroup } = await import("./DockedPanelGroup");

beforeAll(() => {
  const win = new Window({ url: "http://localhost/" });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).navigator = win.navigator;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).Element = win.Element;
  (globalThis as any).Node = win.Node;
  (globalThis as any).SVGElement = win.SVGElement;
  (globalThis as any).MutationObserver = win.MutationObserver;
  (globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("DockedPanelGroup", () => {
  test("renders tabs and forwards resize + drag handlers", () => {
    let resized = 0;
    let dragged = 0;

    const { container } = render(
      <DockedPanelGroup
        position="right"
        size={320}
        activeTabId="terminal"
        onActiveTabChange={() => {}}
        onPositionChange={() => {}}
        onDragStart={() => { dragged += 1; }}
        onResizeStart={() => { resized += 1; }}
        tabs={[
          {
            id: "terminal",
            label: "Terminal",
            icon: <span>T</span>,
            content: <div>Terminal content</div>,
          },
          {
            id: "files",
            label: "Files",
            icon: <span>F</span>,
            content: <div>Files content</div>,
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Terminal");
    expect(container.textContent).toContain("Files");
    expect(container.textContent).toContain("Terminal content");

    const elements = Array.from(container.getElementsByTagName("*"));
    const dragHandle = elements.find((el) => el.getAttribute("aria-label") === "Drag to reposition panel") as HTMLElement | undefined;
    expect(dragHandle).toBeTruthy();
    fireEvent.pointerDown(dragHandle!);
    expect(dragged).toBe(1);

    const resizeHandle = elements.find((el) => (el as HTMLElement).className?.includes?.("cursor-col-resize")) as HTMLElement | undefined;
    expect(resizeHandle).toBeTruthy();
    fireEvent.pointerDown(resizeHandle!);
    expect(resized).toBe(1);
  });
});
