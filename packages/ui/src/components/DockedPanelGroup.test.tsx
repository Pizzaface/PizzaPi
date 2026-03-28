import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

// Set up DOM globals BEFORE any component imports — transitive deps
// (lucide-react, ReactDOM) need a DOM at module-evaluation time.
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

// Eagerly import CombinedPanel (DOM globals are already set above) and
// register the mock synchronously — async mock factories resolve too late
// when Bun evaluates modules in parallel across test files.
const CombinedPanelModule = await import("./CombinedPanel");
mock.module("@/components/CombinedPanel", () => CombinedPanelModule);

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same Bun worker process.
afterAll(() => mock.restore());

const { DockedPanelGroup } = await import("./DockedPanelGroup");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const TAB_PROPS = {
  activeTabId: "terminal",
  onActiveTabChange: () => {},
  onPositionChange: () => {},
  tabs: [
    { id: "terminal", label: "Terminal", icon: <span>T</span>, content: <div>Terminal content</div> },
    { id: "files",    label: "Files",    icon: <span>F</span>, content: <div>Files content</div>    },
  ],
};

describe("DockedPanelGroup", () => {
  test("renders tabs and forwards drag handler (right-middle zone)", () => {
    let dragged = 0;
    const { container } = render(
      <DockedPanelGroup
        {...TAB_PROPS}
        position="right-middle"
        size={320}
        onDragStart={() => { dragged += 1; }}
        onResizeStart={() => {}}
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

    // NOTE: column-width resize handles for left-*/right-* zones are managed at
    // the column level in App.tsx, NOT inside DockedPanelGroup. The component
    // only renders an inline row-resize handle for center-top / center-bottom.
    const colResizeHandle = elements.find((el) => (el as HTMLElement).className?.includes?.("cursor-col-resize"));
    expect(colResizeHandle).toBeUndefined(); // by design — handled in App.tsx
  });

  test("double-clicking a tab collapses and restores the panel", () => {
    const { container } = render(
      <DockedPanelGroup
        {...TAB_PROPS}
        position="center-bottom"
        size={280}
        onDragStart={() => {}}
        onResizeStart={() => {}}
      />,
    );

    const getPanelWrapper = () => Array.from(container.getElementsByTagName("div")).find((el) => (el as HTMLElement).style.height) as HTMLElement | undefined;
    const panelWrapper = getPanelWrapper();
    expect(panelWrapper).toBeTruthy();
    expect(panelWrapper!.style.height).toBe("280px");

    const terminalTab = Array.from(container.getElementsByTagName("div")).find((el) => (el as HTMLElement).className?.includes?.("border-primary")) as HTMLElement | undefined;
    expect(terminalTab).toBeTruthy();

    fireEvent.doubleClick(terminalTab!);
    expect(getPanelWrapper()!.style.height).toBe("32px");

    const elementsAfterCollapse = Array.from(container.getElementsByTagName("*"));
    const resizeHandleAfterCollapse = elementsAfterCollapse.find((el) => (el as HTMLElement).className?.includes?.("cursor-row-resize"));
    expect(resizeHandleAfterCollapse).toBeUndefined();

    fireEvent.doubleClick(terminalTab!);
    expect(getPanelWrapper()!.style.height).toBe("280px");
  });

  test("center-bottom zone renders an inline row-resize handle", () => {
    let resized = 0;
    const { container } = render(
      <DockedPanelGroup
        {...TAB_PROPS}
        position="center-bottom"
        size={280}
        onDragStart={() => {}}
        onResizeStart={() => { resized += 1; }}
      />,
    );

    const elements = Array.from(container.getElementsByTagName("*"));
    const resizeHandle = elements.find((el) => (el as HTMLElement).className?.includes?.("cursor-row-resize")) as HTMLElement | undefined;
    expect(resizeHandle).toBeTruthy();
    fireEvent.pointerDown(resizeHandle!);
    expect(resized).toBe(1);
  });
});
