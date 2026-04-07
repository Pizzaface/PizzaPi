/**
 * Tests for RunnerTriggersPanel
 */
import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).SyntaxError = globalThis.SyntaxError;
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
const actualPathModule = await import("../lib/path");
mock.module("@/lib/path", () => actualPathModule);

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

  test("renders saved json listener params and shows a textarea editor for json params", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "config", label: "Config", type: "json" }] }],
        listeners: [
          { listenerId: "listener-json", triggerType: "svc:event", params: { config: { users: ["jordanpizza"], flags: { dryRun: true } } }, createdAt: "2026-04-03T00:00:00.000Z" },
        ],
      },
    };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />));
    });

    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => {
      fireEvent.click(accordionBtn!);
    });

    expect(container.textContent).toContain('config={"users":["jordanpizza"],"flags":{"dryRun":true}}');

    const addBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Add another listener for svc:event");
    await act(async () => {
      fireEvent.click(addBtn!);
    });

    const textareas = Array.from(container.getElementsByTagName("textarea"));
    const textarea = textareas[textareas.length - 1];
    expect(textarea).toBeDefined();
  });

  test("submits multiselect listener params as arrays and renders array values as separate chips", async () => {
    let postBody: any = null;
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{
          type: "svc:event",
          label: "Service Event",
          params: [{ name: "channel", label: "Channel", type: "string", enum: ["alerts", "debug", "info"], multiselect: true }],
        }],
        listeners: [
          { listenerId: "listener-1", triggerType: "svc:event", params: { channel: ["alerts", "debug"] }, createdAt: "2026-04-03T00:00:00.000Z" },
        ],
      },
    };

    fetchSpy.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/api/runners/runner-1/trigger-listeners") && (opts?.method ?? "GET") === "POST") {
        postBody = JSON.parse(String(opts?.body ?? "{}"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, listenerId: "listener-new", triggerType: "svc:event" }) } as Response);
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

    const channelChipTexts = Array.from(container.getElementsByTagName("span"))
      .map((el) => el.textContent)
      .filter((text): text is string => !!text && text.startsWith("channel="));
    expect(new Set(channelChipTexts)).toEqual(new Set(["channel=alerts", "channel=debug"]));

    const addBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Add another listener for svc:event");
    await act(async () => {
      fireEvent.click(addBtn!);
    });

    const checkboxes = Array.from(container.getElementsByTagName("input")).filter((input) => (input as HTMLInputElement).type === "checkbox") as HTMLInputElement[];
    const alertsCheckbox = checkboxes.find((input) => input.parentElement?.textContent?.includes("alerts"));
    const debugCheckbox = checkboxes.find((input) => input.parentElement?.textContent?.includes("debug"));
    expect(alertsCheckbox).toBeDefined();
    expect(debugCheckbox).toBeDefined();

    await act(async () => {
      fireEvent.click(alertsCheckbox!);
      fireEvent.click(debugCheckbox!);
    });

    const submitBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("Subscribe"));
    await act(async () => {
      fireEvent.click(submitBtn!);
    });

    expect(postBody).toMatchObject({
      triggerType: "svc:event",
      params: { channel: ["alerts", "debug"] },
    });
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
