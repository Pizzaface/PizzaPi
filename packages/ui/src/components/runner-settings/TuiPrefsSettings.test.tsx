import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
Object.defineProperty(win, "SyntaxError", { value: SyntaxError, configurable: true });
Object.assign(globalThis, {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
    SVGElement: win.SVGElement, DocumentFragment: win.DocumentFragment,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
});
const { default: TuiPrefsSettings } = await import("./TuiPrefsSettings");

afterEach(cleanup);

function panel(tuiSettings: Record<string, unknown> = {}, saving = false) {
    const onSave = mock(async (_section: string, _value: unknown) => {});
    const view = render(<TuiPrefsSettings runnerId="test-runner" config={{}} tuiSettings={tuiSettings} onSave={onSave} saving={saving} />);
    return { ...view, onSave };
}

test("saves valid Pi 1.0 defaults, including PizzaPi's quiet startup", () => {
    const view = panel();
    expect(view.getByLabelText("Terminal Mode").textContent).toContain("Fullscreen");
    expect(view.getByLabelText("Terminal Theme").textContent).toContain("System");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.onSave).toHaveBeenCalledWith("tuiPreferences", {
        tuiMode: "fullscreen", theme: "system", quietStartup: true,
        steeringMode: "one-at-a-time", transport: "auto", doubleEscapeAction: "tree",
        terminal: { clearOnShrink: false }, enableSkillCommands: true,
    });
});

test("preserves custom themes, header startup, and terminal settings it does not edit", () => {
    const view = panel({
        tuiMode: "regular", theme: "my-theme", quietStartup: "header",
        steeringMode: "all", transport: "websocket-cached", doubleEscapeAction: "fork",
        terminal: { clearOnShrink: true, showImages: false, hyperlinks: false },
        enableSkillCommands: false,
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.onSave).toHaveBeenCalledWith("tuiPreferences", {
        tuiMode: "regular", theme: "my-theme", quietStartup: "header",
        steeringMode: "all", transport: "websocket-cached", doubleEscapeAction: "fork",
        terminal: { clearOnShrink: true, showImages: false, hyperlinks: false },
        enableSkillCommands: false,
    });
});

test("replaces invalid values from older preference controls with supported defaults", () => {
    const view = panel({ steeringMode: "manual", transport: "stdio", doubleEscapeAction: "abort", quietStartup: false });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(view.onSave.mock.calls[0]?.[1]).toMatchObject({
        steeringMode: "one-at-a-time", transport: "auto", doubleEscapeAction: "tree", quietStartup: false,
    });
});

test("disables saving while a settings request is pending", () => {
    const view = panel({}, true);
    expect(view.getByRole("button", { name: "Saving…" }).hasAttribute("disabled")).toBe(true);
});
