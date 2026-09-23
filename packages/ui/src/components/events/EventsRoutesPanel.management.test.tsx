import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement", "MutationObserver"]) (globalThis as any)[key] = (win as any)[key];
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => "" });
let route: any;
let routeList: any[] | null = null;
let publishDeliveries: Array<{ status: string }>;
let listenerHistory: any[] | undefined = [];
let routeUpdateError = false;
let routeLoadError = false;
const calls: Array<{ url: string; method: string; body: any }> = [];
const resetRoute = () => { routeList = null; listenerHistory = []; route = { routeId: "r-1", eventType: "github:pr_comment", target: { kind: "session", sessionId: "s-1", runnerId: "runner-1", offlinePolicy: "fail" }, filters: [{ field: "action", value: "opened" }], deliverAs: "followUp", origin: "ui", createdAt: "2026-01-01T00:00:00Z" }; publishDeliveries = [{ status: "pending" }]; };
resetRoute();
const fetchSpy = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); const method = init?.method ?? "GET";
  calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url === "/api/routes") return { ok: !routeLoadError, status: routeLoadError ? 500 : 200, json: async () => routeLoadError ? ({ error: "Route service unavailable" }) : ({ routes: routeList ?? [route] }) } as unknown as Response;
  if (url === "/api/events") {
    if (method === "POST") listenerHistory = [{ deliveryId: "d-1", eventId: "e-1", status: "delivered", sessionId: "s-1", eventType: "github:pr_comment", createdAt: "2026-01-01T00:00:00Z" }];
    return { ok: true, json: async () => ({ deliveries: publishDeliveries }) } as unknown as Response;
  }
  if (method === "PUT" && url.startsWith("/api/routes/") && routeUpdateError) return { ok: false, status: 400, json: async () => ({ error: "Invalid route" }) } as unknown as Response;
  if (url.includes("trigger-listeners")) return { ok: true, json: async () => ({ listeners: [{ listenerId: "r-1", history: listenerHistory }] }) } as unknown as Response;
  if (url.endsWith("/triggers")) return { ok: true, json: async () => ({ triggerDefs: [{ type: "github:pr_comment", label: "PR comment", schema: { type: "object", required: ["comment"], properties: { comment: { type: "string", default: "Test comment" } } }, params: [{ name: "repo", label: "Repository", type: "string" }] }] }) } as unknown as Response;
  return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
});
(globalThis as any).fetch = fetchSpy;
const actualUtils = await import("../../lib/utils");
mock.module("@/lib/utils", () => actualUtils);
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
void React;
const { EventsRoutesPanel } = await import("./EventsRoutesPanel");
const { RunnerTriggersPanel } = await import("../RunnerTriggersPanel");

afterAll(() => mock.restore());
afterEach(() => { cleanup(); document.body.innerHTML = ""; calls.length = 0; fetchSpy.mockClear(); routeUpdateError = false; routeLoadError = false; resetRoute(); });

async function mount() {
  let container!: HTMLElement;
  await act(async () => { ({ container } = render(<EventsRoutesPanel bare runnerId="runner-1" sessions={[{ sessionId: "s-1", sessionName: "Work" }]} runners={[{ runnerId: "runner-1", name: "Local" }]} />)); });
  await waitFor(() => expect(container.textContent).toContain("Triggers"));
  return container;
}

describe("runner-wide trigger manager", () => {
  test("reports route-list load errors instead of an empty state", async () => {
    routeLoadError = true;
    const container = await mount();
    await waitFor(() => expect(container.textContent).toContain("Route service unavailable"));
    expect(container.textContent).not.toContain("No triggers yet");
  });

  test("RunnerTriggersPanel forwards session navigation to route targets", async () => {
    const onOpenSession = mock(() => {});
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" sessions={[{ sessionId: "s-1", sessionName: "Work", runnerId: "runner-1" }]} runners={[{ runnerId: "runner-1", name: "Local" }]} onOpenSession={onOpenSession} />)); });
    await waitFor(() => expect(container.textContent).toContain("Triggers"));
    const target = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Work")!;
    await act(async () => { fireEvent.click(target); });
    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });

  test("opens route targets and actual delivery sessions without toggling expansion", async () => {
    listenerHistory = [{ deliveryId: "d-1", eventId: "e-1", status: "delivered", sessionId: "spawned-session-123", eventType: "github:pr_comment", createdAt: "2026-01-01T00:00:00Z" }];
    const onOpenSession = mock(() => {});
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<EventsRoutesPanel bare runnerId="runner-1" sessions={[{ sessionId: "s-1", sessionName: "Work" }]} runners={[{ runnerId: "runner-1", name: "Local" }]} onOpenSession={onOpenSession} />)); });
    const row = container.querySelector('[aria-expanded="false"]')!;
    const target = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Work")!;
    await act(async () => { fireEvent.click(target); });
    expect(onOpenSession).toHaveBeenLastCalledWith("s-1");
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await act(async () => { fireEvent.click(row); });
    await waitFor(() => expect(container.textContent).toContain("Session spawned-"));
    const deliverySession = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Session spawned-");
    expect(deliverySession).toBeTruthy();
    await act(async () => { fireEvent.click(deliverySession!); });
    expect(onOpenSession).toHaveBeenLastCalledWith("spawned-session-123");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  test("does not link unresolved spawn intents as if they were real sessions", async () => {
    listenerHistory = [{ deliveryId: "d-pending", eventId: "e-pending", status: "pending", sessionId: "spawn:r-1:e-pending", spawnRouteId: "r-1", eventType: "github:pr_comment", createdAt: "2026-01-01T00:00:00Z" }];
    const onOpenSession = mock(() => {});
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<EventsRoutesPanel bare runnerId="runner-1" sessions={[{ sessionId: "s-1", sessionName: "Work" }]} runners={[{ runnerId: "runner-1", name: "Local" }]} onOpenSession={onOpenSession} />)); });
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("Session spawn:r-");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.startsWith("Session spawn:"))).toBe(false);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  test("shows server-enabled event routes, delivery policy, and route-specific test fire", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Enabled · waiting for event");
    expect(container.querySelector('[aria-label="Search triggers"]')).toBeTruthy();
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("Fail immediately");
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Queue after current turn");
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Test")!); });
    const call = calls.find((entry) => entry.url === "/api/events" && entry.method === "POST");
    expect(call?.body).toEqual({ type: "github:pr_comment", routeIds: ["r-1"], payload: { action: "opened", comment: "Test comment" }, summary: "Test trigger" });
  });

  test("updates expanded route history after Test reloads listener delivery history", async () => {
    listenerHistory = [];
    const container = await mount();
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("No delivery history.");
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Test")!); });
    await waitFor(() => expect(container.textContent).toContain("delivered"));
    expect(calls.filter((entry) => entry.url.includes("trigger-listeners")).length).toBeGreaterThanOrEqual(2);
  });

  test("refuses to claim a test worked when publish matched no delivery", async () => {
    publishDeliveries = [];
    const container = await mount();
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Test")!); });
    await waitFor(() => expect(container.textContent).toContain("no delivery matched this trigger"));
    expect(calls.some((entry) => entry.url === "/api/events" && entry.body?.routeIds?.[0] === "r-1")).toBe(true);
  });

  test("pause is persisted and disables test while paused", async () => {
    route.disabled = true;
    const container = await mount();
    expect(container.textContent).toContain("Paused");
    expect(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Test")).toHaveProperty("disabled", true);
    await act(async () => { fireEvent.click(container.querySelector('[aria-label="Resume route"]')!); });
    await waitFor(() => expect(calls.some((entry) => entry.url === "/api/routes/r-1" && entry.method === "PUT" && entry.body?.disabled === false)).toBe(true));
  });

  test("runner manager excludes routes targeting other runners", async () => {
    routeList = [
      route,
      { ...route, routeId: "r-other-session", eventType: "other:session_route", target: { kind: "session", sessionId: "s-other", runnerId: "runner-2" } },
      { ...route, routeId: "r-other-spawn", eventType: "other:spawn_route", target: { kind: "spawn", spec: { runnerId: "runner-2", cwd: "/other" } } },
    ];
    const container = await mount();
    expect(container.textContent).toContain("github:pr_comment");
    expect(container.textContent).not.toContain("other:session_route");
    expect(container.textContent).not.toContain("other:spawn_route");
  });

  test("event route runtime unknown does not leak into the event-driven state", async () => {
    route = { ...route, runtime: { state: "unknown" } };
    const container = await mount();
    expect(container.textContent).toContain("Enabled · waiting for event");
    expect(container.textContent).not.toContain("Unknown");
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("State: Enabled · waiting for event");
    expect(container.textContent).not.toContain("State: Unknown");
  });

  test("custom scheduler next-fire status is treated as a schedule", async () => {
    route = { ...route, eventType: "pizzawork:daily_report", runtime: { state: "confirmed", nextFireAt: "2026-09-24T08:00:00Z" } };
    const container = await mount();
    expect(container.textContent).not.toContain("Enabled · waiting for event");
    expect(container.textContent).toContain("Active");
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("Next fire:");
  });

  test("maps schedule runtime states and shows delivery history details", async () => {
    listenerHistory = undefined;
    route = { ...route, eventType: "time:cron", runtime: { state: "confirmed", nextFireAt: "2026-09-24T08:00:00Z" }, history: [{ deliveryId: "d-1", eventId: "e-1", status: "failed", failureReason: "offline_policy", sessionId: "s-1", eventType: "time:cron", createdAt: "2026-09-23T10:00:00Z" }] };
    const container = await mount();
    expect(container.textContent).toContain("Active");
    await act(async () => { fireEvent.click(container.querySelector('[aria-expanded="false"]')!); });
    expect(container.textContent).toContain("Next fire:");
    expect(container.textContent).toContain("Failed · offline policy");
  });

  test("opens New trigger on demand and creates a route with the chosen session and offline policy", async () => {
    const container = await mount();
    expect(container.textContent).not.toContain("Source / event");
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "New trigger")!); });
    await waitFor(() => expect(container.textContent).toContain("New trigger"));
    const sourceLabel = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("Source / event"))!;
    const sourceSelect = container.querySelector(`#${sourceLabel.htmlFor}`) as HTMLSelectElement;
    await act(async () => { fireEvent.change(sourceSelect, { target: { value: "github:pr_comment" } }); });
    const sessionLabel = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("Target session"))!;
    const sessionSelect = container.querySelector(`#${sessionLabel.htmlFor}`) as HTMLSelectElement;
    await act(async () => { fireEvent.change(sessionSelect, { target: { value: "s-1" } }); });
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Add trigger")!); });
    await waitFor(() => expect(calls.some((entry) => entry.url === "/api/routes" && entry.method === "POST")).toBe(true));
    expect(calls.find((entry) => entry.url === "/api/routes" && entry.method === "POST")?.body).toMatchObject({
      eventType: "github:pr_comment", target: { kind: "session", sessionId: "s-1", offlinePolicy: "wait" }, origin: "ui",
    });
  });

  test("edit opens the same form with its saved parameters", async () => {
    route = { ...route, params: { repo: "org/project" } };
    const container = await mount();
    await act(async () => { fireEvent.click(container.querySelector('[aria-label="Edit route"]')!); });
    await waitFor(() => expect(container.textContent).toContain("Edit trigger"));
    const repoLabel = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("Repository"))!;
    expect((container.querySelector(`#${repoLabel.htmlFor}`) as HTMLInputElement).value).toBe("org/project");
  });

  test("keeps edit values and the form open after a failed save", async () => {
    route = { ...route, params: { repo: "org/project" } };
    routeUpdateError = true;
    const container = await mount();
    await act(async () => { fireEvent.click(container.querySelector('[aria-label="Edit route"]')!); });
    const repoLabel = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("Repository"))!;
    const repoInput = container.querySelector(`#${repoLabel.htmlFor}`) as HTMLInputElement;
    await act(async () => { fireEvent.change(repoInput, { target: { value: "org/changed" } }); });
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Save trigger")!); });
    await waitFor(() => expect(container.textContent).toContain("Invalid route"));
    expect(container.textContent).toContain("Edit trigger");
    expect(repoInput.value).toBe("org/changed");
  });

  test("delete requires confirmation and removes only the selected trigger", async () => {
    const container = await mount();
    await act(async () => { fireEvent.click(container.querySelector('[aria-label="Delete route"]')!); });
    await act(async () => { fireEvent.click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Delete?")!); });
    await waitFor(() => expect(calls.some((entry) => entry.url === "/api/routes/r-1" && entry.method === "DELETE")).toBe(true));
  });

  test("config routes stay read-only", async () => {
    route.origin = "config";
    const container = await mount();
    for (const label of ["Test", "Pause route", "Edit route", "Delete route"]) {
      const button = container.querySelector(`[aria-label="${label}"]`) ?? Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
      if (button) expect(button).toHaveProperty("disabled", true);
    }
  });
});
