/**
 * Tests for TriggersPanel
 *
 * Covers:
 *   - Renders empty state when no triggers are returned
 *   - Renders trigger list with entries
 *   - Groups triggers by linked session
 *   - Shows "Awaiting Response" for pending triggers
 *   - Shows expanded event history
 *   - Trigger catalog and subscriptions
 *   - Send trigger dialog
 *   - Real-time status updates
 */
import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

// ── DOM globals ──────────────────────────────────────────────────────────────
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
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Shared fetch mock state ───────────────────────────────────────────────────
interface MockFetchResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

const fetchState: {
  response: MockFetchResponse;
  urlOverrides?: Record<string, MockFetchResponse>;
} = {
  response: { ok: true, body: { triggers: [] } },
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

// ── Module mocks ─────────────────────────────────────────────────────────────
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
  const Badge = ({ children, ...props }: any) =>
    R.createElement("span", props, children);
  return { Badge };
});

mock.module("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

mock.module("@/components/ui/dialog", () => {
  const R = require("react");
  const DialogCtx = R.createContext<{ open: boolean; onOpenChange: (v: boolean) => void }>({
    open: false,
    onOpenChange: () => {},
  });

  const Dialog = ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (v: boolean) => void; children?: R.ReactNode }) => {
    const [localOpen, setLocalOpen] = R.useState(false);
    const isOpen = open !== undefined ? open : localOpen;
    const handleChange = onOpenChange ?? setLocalOpen;
    return R.createElement(DialogCtx.Provider, { value: { open: isOpen, onOpenChange: handleChange } }, children);
  };

  const DialogContent = ({ children }: { children?: R.ReactNode }) => {
    const { open } = R.useContext(DialogCtx);
    if (!open) return null;
    return R.createElement("div", { "data-dialog-content": true }, children);
  };

  const DialogHeader = ({ children }: { children?: R.ReactNode }) => R.createElement("div", {}, children);
  const DialogTitle = ({ children }: { children?: R.ReactNode }) => R.createElement("h2", {}, children);
  const DialogFooter = ({ children }: { children?: R.ReactNode }) => R.createElement("div", {}, children);
  const DialogTrigger = ({ children }: { children?: R.ReactNode }) => R.createElement(R.Fragment, {}, children);
  const DialogDescription = ({ children }: { children?: R.ReactNode }) => R.createElement("p", {}, children);
  const DialogClose = ({ children }: { children?: R.ReactNode }) => {
    const { onOpenChange } = R.useContext(DialogCtx);
    return R.createElement("button", { onClick: () => onOpenChange(false) }, children);
  };

  return { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription, DialogClose };
});

afterAll(() => mock.restore());

// Import AFTER globals are set
const { TriggersPanel } = await import("./TriggersPanel");
import type { TriggerHistoryEntry } from "./TriggersPanel";

// ── Lifecycle ────────────────────────────────────────────────────────────────
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  fetchSpy.mockClear();
  fetchState.response = { ok: true, body: { triggers: [] } };
  fetchState.urlOverrides = undefined;
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeTrigger(overrides: Partial<TriggerHistoryEntry> = {}): TriggerHistoryEntry {
  return {
    triggerId: "trig_001",
    type: "webhook",
    source: "github",
    payload: { action: "push", ref: "refs/heads/main" },
    deliverAs: "steer",
    ts: new Date(Date.now() - 60_000).toISOString(),
    direction: "inbound",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("TriggersPanel — empty state", () => {
  test("renders empty state message when no triggers are returned", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).toContain("No triggers yet");
  });

  test("renders loading spinner initially", async () => {
    let resolveFetch!: () => void;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = () =>
            res({
              ok: true,
              status: 200,
              json: async () => ({ triggers: [] }),
            } as Response);
        }),
    );

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    const svgs = container.getElementsByTagName("svg");
    expect(svgs.length).toBeGreaterThan(0);

    await act(async () => { resolveFetch(); });
  });

  test("renders error message when fetch fails", async () => {
    fetchState.response = { ok: false, status: 500, body: { error: "Internal Server Error" } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).toContain("HTTP 500");
  });
});

describe("TriggersPanel — grouped layout", () => {
  test("groups child session triggers under Awaiting Response when pending", async () => {
    const trigger = makeTrigger({
      triggerId: "t-pending",
      type: "ask_user_question",
      source: "child-session-abc",
      direction: "inbound",
      // No response — pending
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    expect(container.textContent).toContain("asking question");
    expect(container.textContent).toContain("Waiting for your answer");
  });

  test("groups child session triggers under Linked Sessions when responded", async () => {
    const trigger = makeTrigger({
      triggerId: "t-responded",
      type: "plan_review",
      source: "child-session-abc",
      direction: "inbound",
      response: { action: "approve", text: "OK", ts: new Date().toISOString() },
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    expect(container.textContent).toContain("responded");
  });

  test("shows external/API triggers under Other Events grouped by source", async () => {
    const trigger = makeTrigger({
      triggerId: "t-ext",
      type: "webhook",
      source: "external:github",
      direction: "inbound",
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    // Source group accordion shows source label
    expect(container.textContent).toContain("github");
    expect(container.textContent).toContain("1 event");

    // Expand the source group to see the trigger type
    const buttons = Array.from(container.getElementsByTagName("button"));
    const groupBtn = buttons.find((b) => b.textContent?.includes("github"));
    expect(groupBtn).toBeDefined();
    await act(async () => { fireEvent.click(groupBtn!); });
    expect(container.textContent).toContain("webhook");
  });

  test("shows multiple events from same child in one group", async () => {
    const t1 = makeTrigger({
      triggerId: "t1",
      type: "ask_user_question",
      source: "child-sess-xyz",
      direction: "inbound",
      response: { action: "answered", ts: new Date().toISOString() },
      ts: new Date(Date.now() - 120_000).toISOString(),
    });
    const t2 = makeTrigger({
      triggerId: "t2",
      type: "session_complete",
      source: "child-sess-xyz",
      direction: "inbound",
      ts: new Date(Date.now() - 30_000).toISOString(),
    });
    fetchState.response = { ok: true, body: { triggers: [t2, t1] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    expect(container.textContent).toContain("completed");
    // Should show event count
    expect(container.textContent).toContain("2 events");
  });

  test("pending plan_review shows correct waiting text", async () => {
    const trigger = makeTrigger({
      triggerId: "t-plan",
      type: "plan_review",
      source: "child-session-plan",
      summary: "Feature Builder",
      direction: "inbound",
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    expect(container.textContent).toContain("Waiting for plan approval");
    expect(container.textContent).toContain("Feature Builder");
  });
});

describe("TriggersPanel — expandable history", () => {
  test("clicking a session group expands event history", async () => {
    const trigger = makeTrigger({
      triggerId: "t-expand",
      type: "session_complete",
      source: "child-abc",
      direction: "inbound",
      response: { action: "ack", ts: new Date().toISOString() },
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    // Initially, the event details shouldn't be visible (collapsed)
    // The session_complete type should appear in the group summary
    const buttons = Array.from(container.getElementsByTagName("button"));
    const groupBtn = buttons.find((b) => b.textContent?.includes("child-abc"));
    expect(groupBtn).toBeDefined();

    // Click to expand
    await act(async () => {
      fireEvent.click(groupBtn!);
    });

    // Now the event details should be visible (session_complete row with follow-up badge etc.)
    expect(container.textContent).toContain("session_complete");
  });
});

describe("TriggersPanel — Send Trigger dialog", () => {
  test("dialog does not show payload editor initially", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(document.body.textContent).not.toContain("Payload (JSON)");
    expect(document.body.textContent).not.toContain("Deliver As");
  });

  test("dialog opens when Send button is clicked", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    const buttons = Array.from(container.getElementsByTagName("button"));
    const sendBtn = buttons.find((b) => b.textContent?.includes("Send"));
    expect(sendBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(sendBtn!);
    });

    expect(document.body.textContent).toContain("Payload (JSON)");
    expect(document.body.textContent).toContain("Deliver As");
  });

  test("dialog closes when Cancel is clicked", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    const buttons = Array.from(container.getElementsByTagName("button"));
    const sendBtn = buttons.find((b) => b.textContent?.includes("Send"));

    await act(async () => {
      fireEvent.click(sendBtn!);
    });

    expect(document.body.textContent).toContain("Payload (JSON)");

    const allButtons = Array.from(document.getElementsByTagName("button"));
    const cancelBtn = allButtons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(cancelBtn!);
    });

    expect(document.body.textContent).not.toContain("Payload (JSON)");
    expect(document.body.textContent).not.toContain("Deliver As");
  });
});

describe("TriggersPanel — trigger catalog", () => {
  test("renders service accordions when triggerDefs are provided", async () => {
    fetchState.response = { ok: true, body: { triggers: [], subscriptions: [] } };

    const triggerDefs = [
      { type: "godmother:idea_moved", label: "Idea Status Changed", description: "Fires when an idea moves" },
      { type: "godmother:idea_created", label: "Idea Created" },
    ];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Catalog is default tab when triggerDefs exist — shows service accordion
    expect(container.textContent).toContain("godmother");
    expect(container.textContent).toContain("2 triggers");

    // Expand the godmother accordion
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("godmother"));
    expect(accordionBtn).toBeDefined();
    await act(async () => { fireEvent.click(accordionBtn!); });

    expect(container.textContent).toContain("godmother:idea_moved");
    expect(container.textContent).toContain("Idea Status Changed");
    expect(container.textContent).toContain("godmother:idea_created");
    expect(container.textContent).toContain("Fires when an idea moves");
  });

  test("does NOT render Available Triggers section when triggerDefs is empty", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={[]} />));
    });

    expect(container.textContent).not.toContain("Available Triggers");
  });

  test("renders subscribe button for unsubscribed trigger types", async () => {
    fetchState.urlOverrides = {
      "trigger-subscriptions": { ok: true, body: { subscriptions: [] } },
    };

    const triggerDefs = [{ type: "svc:event", label: "Service Event" }];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Catalog is default tab — expand the "svc" service accordion
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(accordionBtn!); });

    const buttons = Array.from(container.getElementsByTagName("button"));
    const subscribeBtn = buttons.find((b) => b.getAttribute("aria-label")?.startsWith("Subscribe to"));
    expect(subscribeBtn).toBeDefined();
  });

  test("renders subscribed badge when session is subscribed to a trigger type", async () => {
    fetchState.urlOverrides = {
      "trigger-subscriptions": { ok: true, body: { subscriptions: [{ triggerType: "svc:event", runnerId: "runner-A" }] } },
    };

    const triggerDefs = [{ type: "svc:event", label: "Service Event" }];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Catalog is default tab — expand the "svc" service accordion
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(accordionBtn!); });

    expect(container.textContent).toContain("subscribed");
    const buttons = Array.from(container.getElementsByTagName("button"));
    const unsubBtn = buttons.find((b) => b.getAttribute("aria-label")?.startsWith("Unsubscribe from"));
    expect(unsubBtn).toBeDefined();
  });

  test("trigger_delivered viewer event triggers immediate refresh", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    const mockSocket = {
      on: (event: string, fn: (...args: any[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(fn);
      },
      off: (event: string, fn: (...args: any[]) => void) => {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter((h) => h !== fn);
        }
      },
    };

    await act(async () => {
      render(<TriggersPanel sessionId="sess-abc" viewerSocket={mockSocket} />);
    });

    expect(handlers["trigger_delivered"]?.length).toBe(1);

    fetchSpy.mockClear();

    fetchState.response = {
      ok: true,
      body: {
        triggers: [{
          triggerId: "test-1",
          type: "session_trigger",
          source: "child-sess-123",
          payload: {},
          deliverAs: "steer",
          ts: new Date().toISOString(),
          direction: "inbound",
        }],
      },
    };

    await act(async () => {
      handlers["trigger_delivered"][0]({ triggerId: "test-1" });
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(fetchSpy).toHaveBeenCalled();
  });

  test("service accordion can be expanded and collapsed", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    const triggerDefs = [{ type: "svc:event", label: "Service Event" }];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Catalog is default tab — service accordion header visible but collapsed
    expect(container.textContent).toContain("svc");
    expect(container.textContent).not.toContain("svc:event");

    // Expand
    const accordionBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    expect(accordionBtn).toBeDefined();
    await act(async () => { fireEvent.click(accordionBtn!); });
    expect(container.textContent).toContain("svc:event");

    // Collapse again
    const collapseBtn = Array.from(container.getElementsByTagName("button")).find((b) => b.textContent?.includes("svc"));
    await act(async () => { fireEvent.click(collapseBtn!); });
    expect(container.textContent).not.toContain("svc:event");
  });
});

describe("TriggersPanel — status updates", () => {
  test("subscribes to trigger_status_update events on viewer socket", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    const mockSocket = {
      on: (event: string, fn: (...args: any[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(fn);
      },
      off: (event: string, fn: (...args: any[]) => void) => {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter((h) => h !== fn);
        }
      },
    };

    await act(async () => {
      render(<TriggersPanel sessionId="sess-abc" viewerSocket={mockSocket} />);
    });

    // Should have registered both event listeners
    expect(handlers["trigger_delivered"]?.length).toBe(1);
    expect(handlers["trigger_status_update"]?.length).toBe(1);
  });

  test("displays streaming status update text", async () => {
    const trigger = makeTrigger({
      triggerId: "t-progress",
      type: "session_complete",
      source: "child-worker",
      direction: "inbound",
      // No response — pending
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    const mockSocket = {
      on: (event: string, fn: (...args: any[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(fn);
      },
      off: (event: string, fn: (...args: any[]) => void) => {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter((h) => h !== fn);
        }
      },
    };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" viewerSocket={mockSocket} />));
    });

    // Fire a status update
    await act(async () => {
      handlers["trigger_status_update"][0]({
        triggerId: "t-progress",
        sourceSessionId: "child-worker",
        statusText: "Working on step 3 of 7",
        ts: new Date().toISOString(),
      });
    });

    expect(container.textContent).toContain("Working on step 3 of 7");
  });

  test("fetches from the correct endpoint for the given sessionId", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    await act(async () => {
      render(<TriggersPanel sessionId="my-session-123" />);
    });

    const calls = fetchSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const url = calls[0][0] as string;
    expect(url).toContain("my-session-123");
    expect(url).toContain("triggers");
  });
});
