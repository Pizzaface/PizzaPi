import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, SVGElement: win.SVGElement, MutationObserver: win.MutationObserver, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }) });
const fetchSpy = mock(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url === "/api/routes") return { ok: true, json: async () => ({ routes: [] }) } as unknown as Response;
  if (url.includes("/trigger-listeners")) return { ok: true, json: async () => ({ listeners: [] }) } as unknown as Response;
  if (url.endsWith("/triggers")) return { ok: true, json: async () => ({ triggerDefs: [] }) } as unknown as Response;
  return { ok: true, json: async () => ({}) } as unknown as Response;
});
(globalThis as any).fetch = fetchSpy;
const actualUtils = await import("../lib/utils");
mock.module("@/lib/utils", () => actualUtils);
const React = (await import("react")).default;
const passthrough = (tag: string) => ({ children, ...props }: any) => React.createElement(tag, props, children);
mock.module("@/components/ui/button", () => ({ Button: React.forwardRef(({ children, ...props }: any, ref: any) => React.createElement("button", { ...props, ref }, children)) }));
mock.module("@/components/ui/input", () => ({ Input: passthrough("input") }));
mock.module("@/components/ui/label", () => ({ Label: passthrough("label") }));
mock.module("@/components/ui/badge", () => ({ Badge: passthrough("span") }));
mock.module("@/components/ui/card", () => ({ Card: passthrough("div"), CardContent: passthrough("div"), CardDescription: passthrough("p"), CardHeader: passthrough("div"), CardTitle: passthrough("div") }));
mock.module("@/components/ui/scroll-area", () => ({ ScrollArea: passthrough("div") }));
mock.module("@/components/ui/spinner", () => ({ Spinner: passthrough("span") }));
const actualEventsRoutesPanel = await import("./events/EventsRoutesPanel");
mock.module("@/components/events/EventsRoutesPanel", () => actualEventsRoutesPanel);
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
void React;
const { RunnerTriggersPanel } = await import("./RunnerTriggersPanel");

afterAll(() => mock.restore());
afterEach(() => { cleanup(); document.body.innerHTML = ""; fetchSpy.mockClear(); });

describe("RunnerTriggersPanel", () => {
  test("mounts the unified runner-wide route manager", async () => {
    let container!: HTMLElement;
    await act(async () => { ({ container } = render(<RunnerTriggersPanel runnerId="runner-1" />)); });
    await waitFor(() => expect(container.textContent).toContain("Triggers"));
    expect(container.querySelector('[aria-label="Search triggers"]')).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === "/api/routes")).toBe(true);
  });

  test("defaults Spawn to the selected runner while keeping other runners available", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <RunnerTriggersPanel
          runnerId="runner-1"
          runners={[
            { runnerId: "runner-2", name: "Runner Two" },
            { runnerId: "runner-1", name: "Runner One" },
          ]}
        />,
      ));
    });
    await waitFor(() => expect(container.querySelector('[aria-label="Search triggers"]')).toBeTruthy());
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("New trigger"))?.click();
    });
    const destination = Array.from(container.querySelectorAll<HTMLSelectElement>("select")).find((select) =>
      Array.from(select.options).some((option) => option.value === "spawn"),
    );
    expect(destination).toBeTruthy();
    await act(async () => { fireEvent.change(destination!, { target: { value: "spawn" } }); });
    const runnerSelect = container.querySelector<HTMLSelectElement>('select[id$="-runner"]');
    expect(runnerSelect?.value).toBe("runner-1");
    expect(Array.from(runnerSelect!.options).map((option) => option.value)).toEqual(["", "runner-1", "runner-2"]);
  });

  test("offers only sessions owned by this runner as route targets", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <RunnerTriggersPanel
          runnerId="runner-1"
          sessions={[
            { sessionId: "session-1", sessionName: "Runner One Session", runnerId: "runner-1" },
            { sessionId: "session-2", sessionName: "Runner Two Session", runnerId: "runner-2" },
          ]}
          runners={[
            { runnerId: "runner-1", name: "Runner One" },
            { runnerId: "runner-2", name: "Runner Two" },
          ]}
        />,
      ));
    });
    await waitFor(() => expect(container.querySelector('[aria-label="Search triggers"]')).toBeTruthy());
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("New trigger"))?.click();
    });
    const targetSelect = container.querySelector<HTMLSelectElement>('select[id$="-session"]');
    expect(targetSelect).toBeTruthy();
    expect(Array.from(targetSelect!.options).map((option) => option.textContent)).toContain("Runner One Session");
    expect(Array.from(targetSelect!.options).map((option) => option.textContent)).not.toContain("Runner Two Session");
  });
});
