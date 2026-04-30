import { afterAll, beforeAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Window } from "happy-dom";
import React from "react";

mock.module("@/lib/utils", () => ({
  cn: (...classes: Array<string | undefined | null | false>) => classes.filter(Boolean).join(" "),
}));

afterAll(() => mock.restore());

const { ProviderIcon } = await import("./ProviderIcon");

beforeAll(() => {
  const win = new Window({ url: "http://localhost/" });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (globalThis as any).window = win;
  (globalThis as any).document = win.document;
  (globalThis as any).navigator = win.navigator;
  (globalThis as any).HTMLElement = win.HTMLElement;
  (globalThis as any).Element = win.Element;
  (globalThis as any).Event = win.Event;
  (globalThis as any).MouseEvent = win.MouseEvent;
  (globalThis as any).MutationObserver = (win as any).MutationObserver;
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

afterEach(() => cleanup());

describe("ProviderIcon", () => {
  test("renders Ollama provider with the Ollama SVG icon", () => {
    const { container } = render(<ProviderIcon provider="ollama-cloud" className="size-4" />);

    const icon = container.getElementsByTagName("svg").item(0);
    expect(icon?.className).toContain("size-4");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.outerHTML).toContain("path");
  });

  test("falls back to generic robot icon for unknown providers", () => {
    const { container } = render(<ProviderIcon provider="unknown-provider" />);

    const icon = container.getElementsByTagName("svg").item(0);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.tagName.toLowerCase()).toBe("svg");
  });

  test("exposes an accessible image when an explicit title is provided", () => {
    const { container } = render(<ProviderIcon provider="ollama-cloud" title="Ollama Cloud" />);

    const icon = container.getElementsByTagName("svg").item(0);
    expect(icon?.getAttribute("role")).toBe("img");
    expect(icon?.getAttribute("aria-label")).toBe("Ollama Cloud");
  });
});
