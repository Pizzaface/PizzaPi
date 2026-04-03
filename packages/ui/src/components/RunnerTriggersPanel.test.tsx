/**
 * Tests for RunnerTriggersPanel
 */
import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
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

interface MockFetchResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

const fetchState: {
  response: MockFetchResponse;
  urlOverrides?: Record<string, MockFetchResponse>;
} = {
  response: { ok: true, body: { triggerDefs: [], listeners: [] } },
};

const fetchSpy = mock(async (url: string, _opts?: RequestInit) => {
  if (fetchState.urlOverrides) {
    for (const [key, override] of Object.entries(fetchState.urlOverrides)) {
      if (url.includes(key)) {
        return {
          ok: override.ok,
          status: override.status ?? (override.ok ? 200 : 500),
          json: async () => override.body,
        } as Response;
      }
    }
  }
  const { ok, status, body } = fetchState.response;
  return {
    ok,
    status: status ?? (ok ? 200 : 500),
    json: async () => body,
  } as Response;
});
(globalThis as any).fetch = fetchSpy;

mock.module("@/components/ui/button", () => {
  const R = require("react");
  const Button = R.forwardRef(({ children, ...props }: any, ref: any) =>
    R.createElement("button", { ...props, ref }, children),
  );
  Button.displayName = "Button";
  return { Button };
});

mock.module("@/components/ui/badge", () => {
  const R = require("react");
  const Badge = ({ children, ...props }: any) => R.createElement("span", props, children);
  return { Badge };
});

mock.module("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

mock.module("@/hooks/useRunnerModels", () => ({
  useRunnerModels: () => ({ models: [] }),
}));


afterAll(() => mock.restore());

const { RunnerTriggersPanel } = await import("./RunnerTriggersPanel");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  fetchSpy.mockClear();
  fetchState.response = { ok: true, body: { triggerDefs: [], listeners: [] } };
  fetchState.urlOverrides = undefined;
});

describe("RunnerTriggersPanel", () => {
  test("renders multiple listeners of the same type with per-listener actions", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch", type: "string" }] }],
        listeners: [
          { listenerId: "listener-1", triggerType: "svc:event", prompt: "one", params: { branch: "main" }, createdAt: "2026-04-03T00:00:00.000Z" },
          { listenerId: "listener-2", triggerType: "svc:event", prompt: "two", params: { branch: "dev" }, createdAt: "2026-04-03T00:01:00.000Z" },
        ],
      },
    };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />));
    });

    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    expect(accordionBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(accordionBtn!);
    });

    // Prompts and params appear as card content
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("two");
    expect(container.textContent).toContain("branch=main");
    expect(container.textContent).toContain("branch=dev");
    expect(container.textContent).toContain("2 active");
    // Per-listener edit/delete buttons still present
    expect(Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Edit listener listener-1 for svc:event")).toBeDefined();
    expect(Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Delete listener listener-2 for svc:event")).toBeDefined();
    expect(Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Add another listener for svc:event")).toBeDefined();
  });

  test("keeps sibling listener actions available while one listener delete is pending", async () => {
    let deleteResolve!: (value: Response) => void;
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [
          { listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z" },
          { listenerId: "listener-2", triggerType: "svc:event", createdAt: "2026-04-03T00:01:00.000Z" },
        ],
      },
    };

    fetchSpy.mockImplementation((url: string, opts?: RequestInit) => {
      if ((opts?.method ?? "GET") === "DELETE" && url.includes("listener-1")) {
        return new Promise<Response>((resolve) => {
          deleteResolve = resolve;
        });
      }
      const { ok, status, body } = fetchState.response;
      return Promise.resolve({
        ok,
        status: status ?? (ok ? 200 : 500),
        json: async () => body,
      } as Response);
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />));
    });

    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => {
      fireEvent.click(accordionBtn!);
    });

    const deleteBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Delete listener listener-1 for svc:event");
    expect(deleteBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(deleteBtn!);
    });

    const siblingDeleteBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Delete listener listener-2 for svc:event");
    const addAnotherBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Add another listener for svc:event");
    expect(siblingDeleteBtn?.hasAttribute("disabled")).toBe(false);
    expect(addAnotherBtn?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      deleteResolve({ ok: true, status: 200, json: async () => ({ ok: true, removed: 1, triggerType: "svc:event", listenerId: "listener-1" }) } as Response);
    });
  });
});
