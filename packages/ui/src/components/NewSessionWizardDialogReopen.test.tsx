import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(win as any).TypeError = globalThis.TypeError;
const originalFetch = globalThis.fetch;
const originalGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    MouseEvent: globalThis.MouseEvent,
    SVGElement: globalThis.SVGElement,
    MutationObserver: globalThis.MutationObserver,
    localStorage: globalThis.localStorage,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
};
Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    SVGElement: win.SVGElement,
    MutationObserver: win.MutationObserver,
    localStorage: win.localStorage,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const { NewSessionWizardDialog } = await import("./NewSessionWizardDialog");

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
    mock.restore();
    Object.assign(globalThis, originalGlobals);
    globalThis.fetch = originalFetch;
});

describe("NewSessionWizardDialog reopen preselection", () => {
    test("preselects the ranked folder after closing and reopening", async () => {
        const folders = ["/projects/top", "/projects/other"];
        globalThis.fetch = mock(async () => ({
            ok: true,
            json: async () => ({ folders }),
        })) as unknown as typeof fetch;
        let open = true;
        const onOpenChange = mock((next: boolean) => {
            open = next;
            rerender(
                <NewSessionWizardDialog
                    open={open}
                    onOpenChange={onOpenChange}
                    preselectedRunnerId="runner-1"
                    runners={[{ runnerId: "runner-1", name: "Runner", sessionCount: 0, isOnline: true }]}
                    onSpawn={async () => {}}
                />,
            );
        });
        const { rerender } = render(
            <NewSessionWizardDialog
                open={open}
                onOpenChange={onOpenChange}
                preselectedRunnerId="runner-1"
                runners={[{ runnerId: "runner-1", name: "Runner", sessionCount: 0, isOnline: true }]}
                onSpawn={async () => {}}
            />,
        );

        const input = await waitFor(() => {
            const element = document.querySelector<HTMLInputElement>("#wizard-cwd");
            expect(element?.value).toBe(folders[0]);
            return element!;
        });
        fireEvent.change(input, { target: { value: folders[0] } });
        expect(input.value).toBe(folders[0]);

        const cancel = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Cancel",
        );
        fireEvent.click(cancel!);
        expect(open).toBe(false);
        open = true;
        rerender(
            <NewSessionWizardDialog
                open={open}
                onOpenChange={onOpenChange}
                preselectedRunnerId="runner-1"
                runners={[{ runnerId: "runner-1", name: "Runner", sessionCount: 0, isOnline: true }]}
                onSpawn={async () => {}}
            />,
        );

        await waitFor(() => expect(document.querySelector<HTMLInputElement>("#wizard-cwd")?.value).toBe(folders[0]));
    });
});
