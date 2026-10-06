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

const fetchSpy = mock(async (_url: string, opts?: RequestInit) => {
  if (opts?.method === "PUT") {
    return { ok: true, json: async () => ({ ok: true, serviceId: "demo", enabled: false }) } as Response;
  }

  return {
    ok: true,
    json: async () => ({
      serviceIds: ["demo"],
      disabledServiceIds: [],
      panels: [{ serviceId: "demo", port: 1234, label: "Demo", icon: "server" }],
      triggerDefs: [],
      sigilDefs: [],
    }),
  } as Response;
});
(globalThis as any).fetch = fetchSpy;

const actualUtils = await import("../lib/utils");
mock.module("@/lib/utils", () => actualUtils);

const actualTooltip = await import("./ui/tooltip");
mock.module("@/components/ui/tooltip", () => actualTooltip);

const actualLucideIcon = await import("./service-panels/lucide-icon");
mock.module("@/components/service-panels/lucide-icon", () => actualLucideIcon);

const actualSwitch = await import("./ui/switch");
mock.module("@/components/ui/switch", () => actualSwitch);

const { RunnerServicesPanel } = await import("./RunnerServicesPanel");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  fetchSpy.mockClear();
});

describe("RunnerServicesPanel", () => {
  test("shows an immediate-apply notice after toggling a service", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <actualTooltip.TooltipProvider>
          <RunnerServicesPanel runnerId="runner-1" />
        </actualTooltip.TooltipProvider>,
      ));
    });

    await waitFor(() => expect(container.textContent).toContain("Demo"));

    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle).toBeDefined();

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(container.textContent).toContain("Disabled");
      expect(container.textContent).toContain('Service "demo" disabled. Change applied immediately.');
    });
  });

  test("renders a disabled-only service without stale metadata", async () => {
    const disabledFetchSpy = mock(async () => ({
      ok: true,
      json: async () => ({
        serviceIds: ["demo"],
        disabledServiceIds: ["godmother-lite"],
        panels: [{ serviceId: "demo", port: 1234, label: "Demo", icon: "server" }],
        triggerDefs: [],
        sigilDefs: [],
      }),
    } as unknown as Response));
    (globalThis as any).fetch = disabledFetchSpy;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <actualTooltip.TooltipProvider>
          <RunnerServicesPanel runnerId="runner-1" />
        </actualTooltip.TooltipProvider>,
      ));
    });

    await waitFor(() => expect(container.textContent).toContain("godmother-lite"));
    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).not.toContain("Godmother Lite");

    (globalThis as any).fetch = fetchSpy;
  });
test("Open in new tab opens the tab within the click, then navigates it to the minted URL", async () => {
    let releaseMint!: () => void;
    const minted = new Promise<void>((resolve) => { releaseMint = resolve; });
    (globalThis as any).fetch = mock(async (url: string, opts?: RequestInit) => {
      if (String(url).endsWith("/api/tunnel-token")) {
        await minted;
        return new Response(JSON.stringify({ url: "/api/tunnel/auth/tok/runner%3Arunner-1/1234/" }), { status: 200 });
      }
      return fetchSpy(url, opts);
    });

    const placeholder = { opener: {} as unknown, closed: false, location: { replace: mock((_u: string) => {}) }, close: mock(() => {}) };
    const openSpy = mock((..._args: unknown[]) => placeholder);
    const originalOpen = (win as any).open;
    (win as any).open = openSpy;
    try {
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = render(
          <actualTooltip.TooltipProvider>
            <RunnerServicesPanel runnerId="runner-1" />
          </actualTooltip.TooltipProvider>,
        ));
      });
      await waitFor(() => expect(container.textContent).toContain("Demo"));

      fireEvent.click(container.querySelector('button[aria-label="Open Demo in new tab"]') as HTMLElement);

      // Synchronously, while the click's user activation is still valid, and
      // before the mint request has completed.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy.mock.calls[0]![0]).toBe("about:blank");
      expect(placeholder.opener).toBeNull();
      expect(placeholder.location.replace).not.toHaveBeenCalled();

      await act(async () => { releaseMint(); });
      await waitFor(() => expect(placeholder.location.replace).toHaveBeenCalledWith(
        "/api/tunnel/auth/tok/runner%3Arunner-1/1234/",
      ));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(placeholder.close).not.toHaveBeenCalled();
    } finally {
      (win as any).open = originalOpen;
      (globalThis as any).fetch = fetchSpy;
    }
  });

  test("Open in new tab closes the placeholder when minting fails", async () => {
    (globalThis as any).fetch = mock(async (url: string, opts?: RequestInit) => {
      if (String(url).endsWith("/api/tunnel-token")) return new Response("nope", { status: 403 });
      return fetchSpy(url, opts);
    });
    const placeholder = { opener: {} as unknown, closed: false, location: { replace: mock((_u: string) => {}) }, close: mock(() => {}) };
    const originalOpen = (win as any).open;
    (win as any).open = mock(() => placeholder);
    try {
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = render(
          <actualTooltip.TooltipProvider>
            <RunnerServicesPanel runnerId="runner-1" />
          </actualTooltip.TooltipProvider>,
        ));
      });
      await waitFor(() => expect(container.textContent).toContain("Demo"));
      fireEvent.click(container.querySelector('button[aria-label="Open Demo in new tab"]') as HTMLElement);
      await waitFor(() => expect(placeholder.close).toHaveBeenCalledTimes(1));
      expect(placeholder.location.replace).not.toHaveBeenCalled();
    } finally {
      (win as any).open = originalOpen;
      (globalThis as any).fetch = fetchSpy;
    }
  });
});
