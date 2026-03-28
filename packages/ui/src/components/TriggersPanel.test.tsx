/**
 * Tests for TriggersPanel
 *
 * Covers:
 *   - Renders empty state when no triggers are returned
 *   - Renders trigger list with entries
 *   - Send trigger dialog opens and closes
 */
import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

// ── DOM globals ──────────────────────────────────────────────────────────────
// Must be set BEFORE any component/hook imports so that React, lucide-react,
// etc. see a DOM at module-evaluation time.
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
// Override getComputedStyle to prevent react-remove-scroll-bar from calling
// querySelectorAll with complex CSS selectors that crash in happy-dom.
(globalThis as any).getComputedStyle = () => ({
  getPropertyValue: () => "",
  paddingRight: "",
  paddingTop: "",
  paddingLeft: "",
  paddingBottom: "",
});
// ResizeObserver stub
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// IntersectionObserver stub
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
  /** Per-URL response overrides (keyed by substring match). */
  urlOverrides?: Record<string, MockFetchResponse>;
} = {
  response: { ok: true, body: { triggers: [] } },
};

const fetchSpy = mock(async (url: string, _opts?: RequestInit) => {
  // Check per-URL overrides first
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
// Mock the Dialog component to avoid Radix UI's react-remove-scroll-bar which
// crashes in happy-dom due to complex CSS querySelectorAll selectors.
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

// Restore mocks after this file
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

    // Wait for loading to complete (loading spinner disappears, empty state appears)
    expect(container.textContent).toContain("No triggers yet");
  });

  test("renders loading spinner initially", async () => {
    // Delay the fetch response so we can observe the loading state
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

    // Should show loading spinner before fetch resolves
    // (check for an svg which is the Loader2 icon, or a loading text)
    const svgs = container.getElementsByTagName("svg");
    expect(svgs.length).toBeGreaterThan(0);

    // Resolve so the component doesn't hang
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

describe("TriggersPanel — trigger list", () => {
  test("renders trigger entries from the API response", async () => {
    const trigger = makeTrigger({ type: "webhook", source: "github" });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).toContain("webhook");
    expect(container.textContent).toContain("github");
  });

  test("renders multiple trigger entries", async () => {
    const t1 = makeTrigger({ triggerId: "t1", type: "custom_event", source: "godmother" });
    const t2 = makeTrigger({ triggerId: "t2", type: "cron_job", source: "scheduler", direction: "outbound" });
    fetchState.response = { ok: true, body: { triggers: [t1, t2] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).toContain("custom_event");
    expect(container.textContent).toContain("cron_job");
  });

  test("shows linked sessions section for inbound non-external triggers", async () => {
    // A trigger from a child session (not "api" or "external:" source)
    const trigger = makeTrigger({
      triggerId: "t-child",
      type: "session_complete",
      source: "child-session-abc",
      direction: "inbound",
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-parent" />));
    });

    // Linked Sessions section should appear
    expect(container.textContent).toContain("Linked Sessions");
    expect(container.textContent).toContain("child-session-abc");
  });

  test("does NOT show linked sessions for external API triggers", async () => {
    const trigger = makeTrigger({
      triggerId: "t-ext",
      type: "webhook",
      source: "api",
      direction: "inbound",
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    // "Linked Sessions" header must NOT appear for "api" source
    expect(container.textContent).not.toContain("Linked Sessions");
  });

  test("shows response status for triggers with response", async () => {
    const trigger = makeTrigger({
      triggerId: "t-resp",
      type: "plan_review",
      source: "child-abc",
      response: { action: "approve", text: "Looks good", ts: new Date().toISOString() },
    });
    fetchState.response = { ok: true, body: { triggers: [trigger] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).toContain("approve");
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

describe("TriggersPanel — Send Trigger dialog", () => {
  test("dialog does not show payload editor initially", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    // The dialog-specific "Payload (JSON)" label is NOT visible initially
    // (the toolbar has "Send Trigger" text, but the dialog payload form is not)
    expect(document.body.textContent).not.toContain("Payload (JSON)");
    expect(document.body.textContent).not.toContain("Deliver As");
  });

  test("dialog opens when Send Trigger button is clicked", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    // Find the "Send Trigger" button in the toolbar
    const buttons = Array.from(container.getElementsByTagName("button"));
    const sendBtn = buttons.find((b) => b.textContent?.includes("Send Trigger"));
    expect(sendBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(sendBtn!);
    });

    // Dialog should now be visible — unique dialog-only content appears
    expect(document.body.textContent).toContain("Payload (JSON)");
    expect(document.body.textContent).toContain("Deliver As");
  });

  test("dialog closes when Cancel is clicked", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    // Open the dialog
    const buttons = Array.from(container.getElementsByTagName("button"));
    const sendBtn = buttons.find((b) => b.textContent?.includes("Send Trigger"));

    await act(async () => {
      fireEvent.click(sendBtn!);
    });

    // Verify dialog is open (dialog-only content is visible)
    expect(document.body.textContent).toContain("Payload (JSON)");

    // Find and click Cancel (all buttons in document)
    const allButtons = Array.from(document.getElementsByTagName("button"));
    const cancelBtn = allButtons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(cancelBtn!);
    });

    // After close: Radix Dialog removes portal content — dialog-only text is gone
    expect(document.body.textContent).not.toContain("Payload (JSON)");
    expect(document.body.textContent).not.toContain("Deliver As");
  });
});

describe("TriggersPanel — trigger catalog", () => {
  test("renders Available Triggers section when triggerDefs are provided", async () => {
    fetchState.response = { ok: true, body: { triggers: [], subscriptions: [] } };

    const triggerDefs = [
      { type: "godmother:idea_moved", label: "Idea Status Changed", description: "Fires when an idea moves" },
      { type: "godmother:idea_created", label: "Idea Created" },
    ];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    expect(container.textContent).toContain("Available Triggers");
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

  test("does NOT render Available Triggers section when triggerDefs is not provided", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" />));
    });

    expect(container.textContent).not.toContain("Available Triggers");
  });

  test("renders subscribe button for unsubscribed trigger types", async () => {
    fetchState.urlOverrides = {
      "trigger-subscriptions": { ok: true, body: { subscriptions: [] } },
    };

    const triggerDefs = [
      { type: "svc:event", label: "Service Event" },
    ];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Subscribe button should be present (aria-label)
    const buttons = Array.from(container.getElementsByTagName("button"));
    const subscribeBtn = buttons.find((b) => b.getAttribute("aria-label")?.startsWith("Subscribe to"));
    expect(subscribeBtn).toBeDefined();
  });

  test("renders subscribed badge when session is subscribed to a trigger type", async () => {
    fetchState.urlOverrides = {
      "trigger-subscriptions": { ok: true, body: { subscriptions: [{ triggerType: "svc:event", runnerId: "runner-A" }] } },
    };

    const triggerDefs = [
      { type: "svc:event", label: "Service Event" },
    ];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    expect(container.textContent).toContain("subscribed");
    // Unsubscribe button should be present
    const buttons = Array.from(container.getElementsByTagName("button"));
    const unsubBtn = buttons.find((b) => b.getAttribute("aria-label")?.startsWith("Unsubscribe from"));
    expect(unsubBtn).toBeDefined();
  });

  test("catalog section can be collapsed", async () => {
    fetchState.response = { ok: true, body: { triggers: [] } };

    const triggerDefs = [
      { type: "svc:event", label: "Service Event" },
    ];

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<TriggersPanel sessionId="sess-abc" triggerDefs={triggerDefs} />));
    });

    // Catalog initially visible
    expect(container.textContent).toContain("svc:event");

    // Click the "Available Triggers" header to collapse
    const buttons = Array.from(container.getElementsByTagName("button"));
    const collapseBtn = buttons.find((b) => b.textContent?.includes("Available Triggers"));
    expect(collapseBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(collapseBtn!);
    });

    // Catalog items should now be hidden
    expect(container.textContent).not.toContain("svc:event");
  });
});
