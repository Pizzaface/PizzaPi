import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

// Set up DOM globals BEFORE importing the component — CombinedPanel's
// transitive deps (lucide-react, ReactDOM) need a DOM at evaluation time.
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

mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));

const { CombinedPanel } = await import("./CombinedPanel");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("CombinedPanel", () => {
  test("close button works for draggable tabs", () => {
    let closed = 0;
    const { container } = render(
      <CombinedPanel
        tabs={[
          {
            id: "tunnels",
            label: "Tunnels",
            icon: <span>T</span>,
            onDragStart: () => {},
            onClose: () => {
              closed += 1;
            },
            content: <div>Tunnel content</div>,
          },
        ]}
        activeTabId="tunnels"
        onActiveTabChange={() => {}}
        position="right-middle"
      />,
    );

    const elements = Array.from(container.getElementsByTagName("*"));
    const closeButton = elements.find((el) => el.getAttribute("aria-label") === "Close Tunnels") as HTMLElement | undefined;
    expect(closeButton).toBeTruthy();

    fireEvent.pointerDown(closeButton!);
    fireEvent.pointerUp(closeButton!);
    fireEvent.click(closeButton!);

    expect(closed).toBe(1);
  });

  test("renders only the active tab content", () => {
    const { container, rerender } = render(
      <CombinedPanel
        tabs={[
          { id: "terminal", label: "Terminal", icon: <span>T</span>, content: <div>Terminal content</div> },
          { id: "files", label: "Files", icon: <span>F</span>, content: <div>Files content</div> },
        ]}
        activeTabId="terminal"
        onActiveTabChange={() => {}}
        position="center-bottom"
      />,
    );

    expect(container.textContent).toContain("Terminal content");
    expect(container.textContent).not.toContain("Files content");

    rerender(
      <CombinedPanel
        tabs={[
          { id: "terminal", label: "Terminal", icon: <span>T</span>, content: <div>Terminal content</div> },
          { id: "files", label: "Files", icon: <span>F</span>, content: <div>Files content</div> },
        ]}
        activeTabId="files"
        onActiveTabChange={() => {}}
        position="center-bottom"
      />,
    );

    expect(container.textContent).not.toContain("Terminal content");
    expect(container.textContent).toContain("Files content");
  });
});
