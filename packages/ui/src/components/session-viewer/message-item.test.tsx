import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import type { RelayMessage } from "./types";

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
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { SessionMessageItem } = await import("./message-item");

afterEach(() => cleanup());

describe("SessionMessageItem custom messages", () => {
  test("shows the full custom message key and collapses content by default", () => {
    const message: RelayMessage = {
      key: "custom-1",
      role: "custom",
      customType: "context:global-rules",
      timestamp: 1_700_000_000_000,
      content: "Full custom message body",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.getByText("Custom")).toBeTruthy();
    expect(view.getByText("• context:global-rules")).toBeTruthy();
    expect(view.queryByText("Full custom message body")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Show message" }));

    expect(view.getByText("Full custom message body")).toBeTruthy();
    expect(view.getByRole("button", { name: "Hide message" })).toBeTruthy();
  });
});
