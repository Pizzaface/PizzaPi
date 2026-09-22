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
    expect(container.textContent).toContain("2 saved");
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

describe("RunnerTriggersPanel — listener setup wizard", () => {
  /** Open the accordion, then open the wizard for svc:event. */
  async function openWizard(container: HTMLElement) {
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(accordionBtn!); });

    const addBtn = Array.from(container.getElementsByTagName("button")).find(
      (b) => b.getAttribute("aria-label")?.startsWith("Add") && b.getAttribute("aria-label")?.includes("svc:event"),
    );
    await act(async () => { fireEvent.click(addBtn!); });
  }

  const findByText = (container: HTMLElement, text: string) =>
    Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes(text));

  test("a trigger with params starts on the params step, not the session step", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch Filter", type: "string" }] }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    // Step 1 is the param step for param-bearing triggers.
    expect(container.textContent).toContain("1. Event Parameters");
    expect(container.textContent).toContain("Branch Filter");
    // The session-target fields belong to a later step.
    expect(container.textContent).not.toContain("Working Dir");
  });

  test("a trigger with no params skips the params step entirely", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    expect(container.textContent).toContain("1. Target Session");
    expect(container.textContent).toContain("Working Dir");
    expect(container.textContent).not.toContain("Event Parameters");
  });

  test("Next walks params → session → review, and Back returns", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch Filter", type: "string" }] }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    expect(container.textContent).toContain("1. Event Parameters");

    await act(async () => { fireEvent.click(findByText(container, "Next")!); });
    expect(container.textContent).toContain("2. Target Session");
    expect(container.textContent).toContain("Working Dir");

    await act(async () => { fireEvent.click(findByText(container, "Next")!); });
    expect(container.textContent).toContain("3. Review & Activate");
    expect(container.textContent).toContain("Listener Summary");
    // Last step has nothing further to advance to.
    expect(findByText(container, "Next")).toBeUndefined();

    await act(async () => { fireEvent.click(findByText(container, "Back")!); });
    expect(container.textContent).toContain("2. Target Session");
  });

  test("the review step echoes the values entered in earlier steps", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{
          type: "svc:event",
          label: "Service Event",
          params: [{ name: "channel", label: "Channel", type: "string", enum: ["alerts", "debug"], multiselect: true }],
        }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    const alertsCheckbox = Array.from(container.getElementsByTagName("input"))
      .filter((i) => (i as HTMLInputElement).type === "checkbox")
      .find((i) => i.parentElement?.textContent?.includes("alerts")) as HTMLInputElement | undefined;
    expect(alertsCheckbox).toBeDefined();
    await act(async () => { fireEvent.click(alertsCheckbox!); });

    // params -> session -> review
    await act(async () => { fireEvent.click(findByText(container, "Next")!); });
    await act(async () => { fireEvent.click(findByText(container, "Next")!); });

    expect(container.textContent).toContain("Listener Summary");
    expect(container.textContent).toContain("channel=alerts");
  });

  test("the submit action stays available on every step (no forced walkthrough)", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch Filter", type: "string" }] }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    // Step 1 already offers Subscribe.
    expect(findByText(container, "Subscribe")).toBeDefined();

    await act(async () => { fireEvent.click(findByText(container, "Next")!); });
    expect(findByText(container, "Subscribe")).toBeDefined();
  });

  test("the stepper dots jump directly to a step", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch Filter", type: "string" }] }],
        listeners: [],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await openWizard(container);

    const jumpToReview = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("title") === "Jump to Step 3");
    expect(jumpToReview).toBeDefined();

    await act(async () => { fireEvent.click(jumpToReview!); });
    expect(container.textContent).toContain("3. Review & Activate");
  });

  test("editing an existing listener opens the wizard pre-populated", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event", params: [{ name: "branch", label: "Branch Filter", type: "string" }] }],
        listeners: [
          { listenerId: "listener-1", triggerType: "svc:event", prompt: "review the merge", params: { branch: "main" }, createdAt: "2026-04-03T00:00:00.000Z" },
        ],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });

    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(accordionBtn!); });

    const editBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === "Edit listener listener-1 for svc:event");
    await act(async () => { fireEvent.click(editBtn!); });

    // Opens on the params step with the saved value, and submits as an update.
    expect(container.textContent).toContain("1. Event Parameters");
    const branchInput = Array.from(container.getElementsByTagName("input")).find(
      (i) => (i as HTMLInputElement).value === "main",
    );
    expect(branchInput).toBeDefined();
    expect(findByText(container, "Update Listener")).toBeDefined();
  });
});

describe("RunnerTriggersPanel — saved route controls", () => {
  /** Expand the svc accordion so listener cards render. */
  async function expand(container: HTMLElement) {
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(accordionBtn!); });
  }

  const findBtnByLabel = (container: HTMLElement, label: string) =>
    Array.from(container.getElementsByTagName("button")).find((b) => b.getAttribute("aria-label") === label);

  test("history rows render outcome, relative time, and a clickable session link", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{
          listenerId: "listener-1",
          triggerType: "svc:event",
          createdAt: "2026-04-03T00:00:00.000Z",
          history: [
            { deliveryId: "d1", eventId: "e1", status: "delivered", sessionId: "sess-hist-1", eventType: "svc:event", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
            { deliveryId: "d2", eventId: "e2", status: "pending", sessionId: "sess-hist-2", eventType: "svc:event", createdAt: new Date(Date.now() - 90 * 60_000).toISOString() },
          ],
        }],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    // Collapsed state shows the count as a toggle button.
    const historyToggle = findBtnByLabel(container, "Toggle run history for listener listener-1");
    expect(historyToggle).toBeDefined();
    expect(container.textContent).toContain("history: 2 runs");
    expect(container.textContent).not.toContain("Delivered");

    await act(async () => { fireEvent.click(historyToggle!); });

    expect(container.textContent).toContain("Delivered");
    expect(container.textContent).toContain("Pending");
    expect(container.textContent).toContain("5m ago");
    expect(container.textContent).toContain("1h ago");

    const link = Array.from(container.getElementsByTagName("a")).find((a) => a.getAttribute("href") === "/session/sess-hist-1");
    expect(link).toBeDefined();
    expect(link!.textContent).toContain("sess-hist-1".slice(0, 8));
  });

  test("fire opens a payload editor prefilled from {} and sends the edited payload", async () => {
    const fireCalls: Array<{ url: string; body: any }> = [];
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z", runtime: { state: "unknown" } }],
      },
    };
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes("/trigger-listeners/listener-1/fire") && (opts?.method ?? "GET") === "POST") {
        fireCalls.push({ url, body: JSON.parse(String(opts?.body ?? "{}")) });
        return { ok: true, status: 200, json: async () => ({ ok: true, eventId: "e-fire" }) } as Response;
      }
      const { ok, status, body } = fetchState.response;
      return { ok, status: status ?? (ok ? 200 : 500), json: async () => body } as Response;
    });

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    // Runtime is unknown but the persisted route is enabled → fire stays available.
    const fireBolt = findBtnByLabel(container, "Fire listener listener-1 for svc:event");
    expect(fireBolt).toBeDefined();
    await act(async () => { fireEvent.click(fireBolt!); });

    const textarea = Array.from(container.getElementsByTagName("textarea")).find(
      (t) => t.getAttribute("aria-label") === "Fire payload for listener listener-1",
    ) as HTMLTextAreaElement | undefined;
    expect(textarea).toBeDefined();
    expect(textarea!.value).toBe("{}");

    await act(async () => { fireEvent.change(textarea!, { target: { value: '{"repo": "org/x"}' } }); });
    const fireSubmit = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent === "Fire");
    await act(async () => { fireEvent.click(fireSubmit!); });

    expect(fireCalls).toHaveLength(1);
    expect(fireCalls[0].body).toEqual({ payload: { repo: "org/x" } });
    // Success closes the editor.
    expect(Array.from(container.getElementsByTagName("textarea")).find(
      (t) => t.getAttribute("aria-label") === "Fire payload for listener listener-1",
    )).toBeUndefined();
  });

  test("fire editor prefills required fields from the trigger schema", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{
          type: "svc:event",
          label: "Service Event",
          schema: { type: "object", required: ["repo", "count"], properties: { repo: { type: "string" }, count: { type: "integer" } } },
        }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z" }],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    await act(async () => { fireEvent.click(findBtnByLabel(container, "Fire listener listener-1 for svc:event")!); });
    const textarea = Array.from(container.getElementsByTagName("textarea")).find(
      (t) => t.getAttribute("aria-label") === "Fire payload for listener listener-1",
    ) as HTMLTextAreaElement | undefined;
    expect(textarea!.value).toBe(JSON.stringify({ repo: "", count: 0 }, null, 2));
  });

  test("fire shows a parse error for invalid JSON and does not POST", async () => {
    const fireCalls: Array<{ url: string }> = [];
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z" }],
      },
    };
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes("/trigger-listeners/listener-1/fire") && (opts?.method ?? "GET") === "POST") {
        fireCalls.push({ url });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      const { ok, status, body } = fetchState.response;
      return { ok, status: status ?? (ok ? 200 : 500), json: async () => body } as Response;
    });

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    await act(async () => { fireEvent.click(findBtnByLabel(container, "Fire listener listener-1 for svc:event")!); });
    const textarea = Array.from(container.getElementsByTagName("textarea")).find(
      (t) => t.getAttribute("aria-label") === "Fire payload for listener listener-1",
    ) as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(textarea, { target: { value: "not json" } }); });
    const fireSubmit = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent === "Fire");
    await act(async () => { fireEvent.click(fireSubmit!); });

    expect(fireCalls).toHaveLength(0);
    expect(container.textContent).toContain("Payload is not valid JSON");
  });

  test("fire surfaces the server error (e.g. disabled route 409)", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z" }],
      },
    };
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes("/trigger-listeners/listener-1/fire") && (opts?.method ?? "GET") === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: "Listener is disabled" }) } as Response;
      }
      const { ok, status, body } = fetchState.response;
      return { ok, status: status ?? (ok ? 200 : 500), json: async () => body } as Response;
    });

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    await act(async () => { fireEvent.click(findBtnByLabel(container, "Fire listener listener-1 for svc:event")!); });
    const fireSubmit = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent === "Fire");
    await act(async () => { fireEvent.click(fireSubmit!); });

    expect(container.textContent).toContain("Listener is disabled");
    expect(container.querySelector("[role='alert']")).not.toBeNull();
  });

  test("owned session routes get disable/delete controls but no spawn wizard edit", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{
          listenerId: "listener-sess",
          triggerType: "svc:event",
          createdAt: "2026-04-03T00:00:00.000Z",
          ownerSessionId: "sess-owner-1",
          ownerSessionName: "Worker session",
          owned: true,
        }],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    expect(container.textContent).toContain("session: Worker session");
    expect(findBtnByLabel(container, "Disable listener listener-sess for svc:event")).toBeDefined();
    expect(findBtnByLabel(container, "Delete listener listener-sess for svc:event")).toBeDefined();
    expect(findBtnByLabel(container, "Fire listener listener-sess for svc:event")).toBeDefined();
    // Session routes have no spawn-spec to edit — the wizard pencil is hidden.
    expect(findBtnByLabel(container, "Edit listener listener-sess for svc:event")).toBeUndefined();
  });

  test("session routes owned by another user render read-only", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{
          listenerId: "listener-sess",
          triggerType: "svc:event",
          createdAt: "2026-04-03T00:00:00.000Z",
          ownerSessionId: "sess-owner-2",
          ownerSessionName: "Someone else",
          owned: false,
        }],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    expect(container.textContent).toContain("read-only");
    expect(findBtnByLabel(container, "Disable listener listener-sess for svc:event")).toBeUndefined();
    expect(findBtnByLabel(container, "Delete listener listener-sess for svc:event")).toBeUndefined();
    expect(findBtnByLabel(container, "Fire listener listener-sess for svc:event")).toBeUndefined();
  });

  test("disabled listeners show the Disabled state and an enable control", async () => {
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z", disabled: true }],
      },
    };

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).toContain("disabled");
    expect(findBtnByLabel(container, "Fire listener listener-1 for svc:event")).toBeUndefined();
    expect(findBtnByLabel(container, "Enable listener listener-1 for svc:event")).toBeDefined();
  });

  test("the disable toggle PUTs the flipped state and refetches", async () => {
    const putCalls: Array<{ url: string; body: any }> = [];
    let routeDisabled = false;
    fetchState.response = {
      ok: true,
      body: {
        triggerDefs: [{ type: "svc:event", label: "Service Event" }],
        listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z" }],
      },
    };
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      const method = opts?.method ?? "GET";
      if (method === "PUT" && url.includes("/trigger-listeners/listener-1")) {
        putCalls.push({ url, body: JSON.parse(String(opts?.body ?? "{}")) });
        routeDisabled = true;
        return { ok: true, status: 200, json: async () => ({ ok: true, listenerId: "listener-1", disabled: true }) } as Response;
      }
      // Every listener GET reflects the current disabled state (initial load
      // and the post-toggle refetch).
      if (method === "GET" && url.includes("/triggers")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            triggerDefs: [{ type: "svc:event", label: "Service Event" }],
            listeners: [{ listenerId: "listener-1", triggerType: "svc:event", createdAt: "2026-04-03T00:00:00.000Z", ...(routeDisabled ? { disabled: true } : {}) }],
          }),
        } as Response;
      }
      const { ok, status, body } = fetchState.response;
      return { ok, status: status ?? (ok ? 200 : 500), json: async () => body } as Response;
    });

    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await expand(container);

    await act(async () => { fireEvent.click(findBtnByLabel(container, "Disable listener listener-1 for svc:event")!); });

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].body).toEqual({ disabled: true });
    // Refetched state renders as disabled.
    expect(container.textContent).toContain("disabled");
    expect(findBtnByLabel(container, "Enable listener listener-1 for svc:event")).toBeDefined();
  });
});
