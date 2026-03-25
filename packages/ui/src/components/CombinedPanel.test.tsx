import { beforeAll, afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

const { CombinedPanel } = await import("./CombinedPanel");

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
        position="right"
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
});
