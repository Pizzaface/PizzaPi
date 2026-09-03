/**
 * RouteForm — catalog-driven route create/edit: type picker from the
 * catalog with free-text fallback, typed params from the def, filter rows,
 * and pre-filled editing.
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

const calls: Array<{ url: string; method?: string; body: any }> = [];

const fetchSpy = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body ?? "null")) });
  return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
});
(globalThis as any).fetch = fetchSpy;

const actualUtils = await import("../../lib/utils");
mock.module("@/lib/utils", () => actualUtils);

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
void React; // JSX factory in scope for the classic transform
const { RouteForm } = await import("./RouteForm");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  fetchSpy.mockClear();
  calls.length = 0;
});

const catalog = [
  {
    type: "time:timer_fired",
    label: "Timer fired",
    params: [
      { name: "duration", label: "Duration", type: "number" as const, required: true, default: 10 },
      { name: "tags", label: "Tags", type: "string" as const, enum: ["urgent", "chill"] },
      { name: "quiet", label: "Quiet", type: "boolean" as const },
    ],
    schema: { properties: { repo: { type: "string" }, stars: { type: "number" } } },
  },
  {
    type: "github:pr_comment",
    label: "PR comment",
    params: [],
  },
];

function selectEventType(container: HTMLElement, value: string) {
  const select = container.querySelector("select") as HTMLSelectElement;
  act(() => {
    select.value = value;
    fireEvent.change(select);
  });
}

describe("RouteForm (create)", () => {
  test("picks a catalog type, renders typed params, and posts a route", async () => {
    const onDone = mock(() => {});
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RouteForm catalog={catalog} targetSessionId="sess-1" onDone={onDone} onCancel={() => {}} />));
    });

    // Type picker is populated and grouped by service.
    const select = container.querySelector("select") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("Timer fired (time:timer_fired)");
    expect(container.querySelector("optgroup[label='time']")).toBeTruthy();
    expect(container.querySelector("optgroup[label='github']")).toBeTruthy();

    // No params until a type with params is picked.
    expect(container.textContent).not.toContain("Parameters");

    selectEventType(container, "time:timer_fired");

    // Params render with declared types: number input, enum select, boolean select.
    await waitFor(() => expect(container.textContent).toContain("Parameters"));
    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(numberInput).toBeTruthy();
    expect(numberInput.value).toBe("10"); // default prefill

    await act(async () => {
      fireEvent.change(numberInput, { target: { value: "45" } });
    });

    // Add a payload filter row and fill it.
    const addFilter = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add filter"),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(addFilter);
    });
    const fieldInput = container.querySelector('input[placeholder="payload field"]') as HTMLInputElement;
    const valueInput = container.querySelector('input[placeholder="expected value"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fieldInput, { target: { value: "repo" } });
      fireEvent.change(valueInput, { target: { value: "PizzaPi/PizzaPi" } });
    });

    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add route"),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/routes");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({
      eventType: "time:timer_fired",
      target: { kind: "session", sessionId: "sess-1" },
      deliverAs: "followUp",
      params: { duration: 45 },
      filters: [{ field: "repo", op: "eq", value: "PizzaPi/PizzaPi" }],
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("free-text fallback validates event types client-side", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RouteForm catalog={[]} onDone={() => {}} onCancel={() => {}} />));
    });

    // No catalog: straight to the free-text input.
    expect(container.querySelector("select")).toBeNull();
    const typeInput = container.querySelector('input[placeholder="github:pr_comment"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(typeInput, { target: { value: "NotNamespaced" } });
    });
    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add route"),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("namespaced"));
    expect(calls).toHaveLength(0);
  });
});

describe("RouteForm (edit)", () => {
  // RoutesTab mounts ONE form instance and flips it between create and edit —
  // regression: mount-time state initializers don't re-run on prop changes.
  test("transitions from create to edit on the same instance and pre-fills", async () => {
    const route = {
      routeId: "rt_2",
      eventType: "time:timer_fired",
      target: { kind: "session" as const, sessionId: "sess-9" },
      deliverAs: "steer" as const,
      params: { duration: 12 },
      origin: "ui" as const,
      createdAt: "2026-01-01T00:00:00Z",
    };
    let view!: { rerender: (ui: React.ReactNode) => void; container: HTMLElement };
    await act(async () => {
      view = render(<RouteForm catalog={catalog} onDone={() => {}} onCancel={() => {}} />);
    });
    // Create mode: no params section until a type is picked.
    expect(view.container.textContent).not.toContain("Parameters");
    expect(view.container.textContent).toContain("New route");

    await act(async () => {
      view.rerender(<RouteForm catalog={catalog} editing={route} onDone={() => {}} onCancel={() => {}} />);
    });

    // Edit mode: type synced from the route, params section rendered + pre-filled.
    await waitFor(() => expect(view.container.textContent).toContain("Edit route"));
    await waitFor(() => expect(view.container.textContent).toContain("Parameters"));
    const numberInput = view.container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(numberInput.value).toBe("12");

    // Clearing the edit target resets the form to create defaults.
    await act(async () => {
      view.rerender(<RouteForm catalog={catalog} onDone={() => {}} onCancel={() => {}} />);
    });
    await waitFor(() => expect(view.container.textContent).toContain("New route"));
    expect(view.container.textContent).not.toContain("Parameters");
  });


  test("opens pre-filled and PUTs the edited values", async () => {
    const route = {
      routeId: "rt_1",
      eventType: "time:timer_fired",
      target: { kind: "session" as const, sessionId: "sess-9" },
      deliverAs: "steer" as const,
      filters: [{ field: "repo", op: "contains" as const, value: "PizzaPi" }],
      params: { duration: 15, note: "hello" },
      origin: "ui" as const,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const onDone = mock(() => {});
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <RouteForm catalog={catalog} editing={route} onDone={onDone} onCancel={() => {}} />,
      ));
    });

    // Editing header + target summary.
    expect(container.textContent).toContain("Edit route");
    expect(container.textContent).toContain("Session sess-9");

    // Prefilled: duration param from the route, filter row from the route.
    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(numberInput.value).toBe("15");
    const fieldInput = container.querySelector('input[placeholder="payload field"]') as HTMLInputElement;
    expect(fieldInput.value).toBe("repo");
    const valueInput = container.querySelector('input[placeholder="expected value"]') as HTMLInputElement;
    expect(valueInput.value).toBe("PizzaPi");
    const opSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      ["eq", "contains"].includes((s as HTMLSelectElement).value),
    ) as HTMLSelectElement;
    expect(opSelect.value).toBe("contains");

    // Change the duration and save.
    await act(async () => {
      fireEvent.change(numberInput, { target: { value: "30" } });
    });
    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Save"),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/routes/rt_1");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({
      eventType: "time:timer_fired",
      deliverAs: "steer",
      params: { duration: 30, note: "hello" },
      filters: [{ field: "repo", op: "contains", value: "PizzaPi" }],
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});