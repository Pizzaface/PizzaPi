/**
 * DeliveryRow behavior via the panel's session-scoped DeliveriesTab:
 * respond controls render only for respondable deliveries, one button per
 * declared contract action, free-text fallback, and inline error on failure.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

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
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => "" });

const baseDelivery = {
  eventId: "evt_1",
  eventType: "lifecycle:plan_review",
  sessionId: "s-1",
  deliverAs: "steer",
  createdAt: "2026-01-01T00:00:00Z",
};

const respondCalls: Array<{ url: string; body: any }> = [];
let respondError: string | null = null;

const fetchSpy = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/sessions/s-1/deliveries") {
    return {
      ok: true,
      json: async () => ({
        deliveries: [
          { ...baseDelivery, deliveryId: "dlv_contract", status: "delivered", respondable: true, actions: ["approve", "cancel"] },
          { ...baseDelivery, deliveryId: "dlv_plain", status: "delivered", respondable: true },
          { ...baseDelivery, deliveryId: "dlv_nocontract", status: "pending", respondable: false },
          { ...baseDelivery, deliveryId: "dlv_answered", status: "responded", respondable: false, response: { action: "approve", text: "ok" } },
        ],
      }),
    } as unknown as Response;
  }
  if (url.includes("/response")) {
    respondCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (respondError) {
      return { ok: false, status: 400, json: async () => ({ error: respondError }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
  }
  return { ok: true, json: async () => ({}) } as unknown as Response;
});
(globalThis as any).fetch = fetchSpy;

const actualUtils = await import("../../lib/utils");
mock.module("@/lib/utils", () => actualUtils);

// Dynamic imports AFTER the happy-dom globals: React captures document
// references at import time, so static imports would type into a dead tree.
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
void React; // JSX factory in scope for the classic transform
const { EventsRoutesPanel } = await import("./EventsRoutesPanel");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  fetchSpy.mockClear();
  respondCalls.length = 0;
  respondError = null;
});

/** The delivery row div that owns a respond input with the given id. */
function rowOf(container: HTMLElement, deliveryId: string): HTMLElement {
  const input = Array.from(container.querySelectorAll("input")).find(
    (el) => el.getAttribute("aria-label") === `Response to delivery ${deliveryId}`,
  );
  if (!input) throw new Error(`no respond input for ${deliveryId}`);
  return input.closest("div.rounded-md") as HTMLElement;
}

function buttonByText(root: Element, text: string): HTMLElement {
  const btn = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLElement;
}

describe("DeliveryRow respond controls", () => {
  test("renders one button per declared action for respondable deliveries only", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<EventsRoutesPanel sessionId="s-1" />));
    });

    await waitFor(() => expect(container.textContent).toContain("lifecycle:plan_review"));

    const labels = Array.from(container.querySelectorAll("input")).map((el) => el.getAttribute("aria-label"));
    expect(labels).toContain("Response to delivery dlv_contract");
    expect(labels).toContain("Response to delivery dlv_plain");
    // Non-respondable and already-answered deliveries render no respond input.
    expect(labels).not.toContain("Response to delivery dlv_nocontract");
    expect(labels).not.toContain("Response to delivery dlv_answered");

    // Contract delivery: one button per declared action.
    const contractRow = rowOf(container, "dlv_contract");
    expect(buttonByText(contractRow, "approve")).toBeTruthy();
    expect(buttonByText(contractRow, "cancel")).toBeTruthy();

    // Free-text fallback delivery (respondable, no declared actions): Send only.
    const plainRow = rowOf(container, "dlv_plain");
    expect(buttonByText(plainRow, "Send")).toBeTruthy();
    expect(Array.from(plainRow.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "approve")).toHaveLength(0);
  });

  test("an action button posts the action and removes the controls", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<EventsRoutesPanel sessionId="s-1" />));
    });
    await waitFor(() => expect(container.textContent).toContain("lifecycle:plan_review"));

    await act(async () => {
      fireEvent.click(buttonByText(rowOf(container, "dlv_contract"), "approve"));
    });

    await waitFor(() => expect(respondCalls).toHaveLength(1));
    expect(respondCalls[0]).toEqual({
      url: "/api/deliveries/dlv_contract/response",
      body: { response: "approve", action: "approve" },
    });

    // Success: the row flips to Responded and the controls disappear.
    await waitFor(() => {
      expect(container.querySelector('input[aria-label="Response to delivery dlv_contract"]')).toBeNull();
      expect(container.textContent).toContain("Responded");
    });
  });

  test("typed text rides along with the action; free-text Send posts without one", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<EventsRoutesPanel sessionId="s-1" />));
    });
    await waitFor(() => expect(container.textContent).toContain("lifecycle:plan_review"));

    // Contract row: typed text rides along with the action.
    const contractRow = rowOf(container, "dlv_contract");
    await act(async () => {
      fireEvent.change(contractRow.querySelector("input") as HTMLInputElement, { target: { value: "ship it" } });
    });
    await act(async () => {
      fireEvent.click(buttonByText(contractRow, "approve"));
    });
    await waitFor(() => expect(respondCalls).toHaveLength(1));
    expect(respondCalls[0].body).toEqual({ response: "ship it", action: "approve" });

    // Plain row (re-queried — the list re-rendered after the first respond):
    // free-text Send posts without an action.
    const plainRow = rowOf(container, "dlv_plain");
    await act(async () => {
      fireEvent.change(plainRow.querySelector("input") as HTMLInputElement, { target: { value: "looks good to me" } });
    });
    await act(async () => {
      fireEvent.click(buttonByText(plainRow, "Send"));
    });
    await waitFor(() => expect(respondCalls).toHaveLength(2));
    expect(respondCalls[1].body).toEqual({ response: "looks good to me" });
  });

  test("calls onBadgeRefresh after a successful respond (badge refresh)", async () => {
    const onBadgeRefresh = mock(() => {});
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<EventsRoutesPanel sessionId="s-1" onBadgeRefresh={onBadgeRefresh} />));
    });
    await waitFor(() => expect(container.textContent).toContain("lifecycle:plan_review"));

    await act(async () => {
      fireEvent.click(buttonByText(rowOf(container, "dlv_contract"), "approve"));
    });

    // The response changes pending trigger counts — the badge hook must refetch.
    await waitFor(() => expect(onBadgeRefresh).toHaveBeenCalledTimes(1));
  });

  test("shows an inline error when the server rejects the response", async () => {
    respondError = "Event has no response contract";
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<EventsRoutesPanel sessionId="s-1" />));
    });
    await waitFor(() => expect(container.textContent).toContain("lifecycle:plan_review"));

    const contractRow = rowOf(container, "dlv_contract");
    await act(async () => {
      fireEvent.click(buttonByText(contractRow, "cancel"));
    });

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Event has no response contract");
    });
    // Failure keeps the row actionable: controls still rendered, not disabled.
    expect(contractRow.querySelector("input")).toBeTruthy();
    expect(contractRow.querySelectorAll("button[disabled]")).toHaveLength(0);
  });
});