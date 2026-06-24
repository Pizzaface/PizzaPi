/**
 * Tests for RunnerServicesPanel
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).localStorage = win.localStorage;

(globalThis as any).getComputedStyle = () => ({
  getPropertyValue: () => "",
  paddingRight: "",
  paddingTop: "",
  paddingLeft: "",
  paddingBottom: "",
});
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

let getCount = 0;
const fetchSpy = mock(async (_url: string, opts?: RequestInit) => {
  if (opts?.method === "PUT") {
    return { ok: true, json: async () => ({ ok: true, serviceId: "demo", enabled: false }) } as Response;
  }

  getCount += 1;
  return {
    ok: true,
    json: async () => ({
      serviceIds: getCount === 1 ? ["demo"] : [],
      disabledServiceIds: getCount === 1 ? [] : ["demo"],
      panels: [{ serviceId: "demo", port: 1234, label: "Demo", icon: "server" }],
      triggerDefs: [],
      sigilDefs: [],
    }),
  } as Response;
});
(globalThis as any).fetch = fetchSpy;

mock.module("@/components/ui/tooltip", () => {
  const R = require("react");
  return {
    Tooltip: ({ children }: any) => R.createElement(R.Fragment, null, children),
    TooltipTrigger: ({ children }: any) => R.createElement(R.Fragment, null, children),
    TooltipContent: ({ children }: any) => R.createElement("div", null, children),
  };
});

mock.module("@/components/service-panels/lucide-icon", () => {
  const R = require("react");
  return { DynamicLucideIcon: () => R.createElement("span", { "data-testid": "icon" }) };
});

mock.module("@/components/ui/switch", () => {
  const R = require("react");
  return {
    Switch: ({ checked, onCheckedChange, disabled }: any) => R.createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked,
      disabled,
      onClick: () => onCheckedChange?.(!checked),
    }),
  };
});

mock.module("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

const { RunnerServicesPanel } = await import("./RunnerServicesPanel");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  fetchSpy.mockClear();
  getCount = 0;
});

describe("RunnerServicesPanel", () => {
  test("shows a runner restart notice after toggling a service", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RunnerServicesPanel runnerId="runner-1" />));
    });

    await waitFor(() => expect(container.textContent).toContain("Demo"));

    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle).toBeDefined();

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Service "demo" disabled. Restart the runner to fully apply this change.');
    });
  });
});
