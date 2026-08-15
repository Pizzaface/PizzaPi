import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as React from "react";

const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).DocumentFragment = win.DocumentFragment;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { default: ModelsSettings } = await import("./ModelsSettings");

afterEach(() => {
    cleanup();
    (globalThis as any).fetch = undefined;
});

const sampleModels = {
    models: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude 4 Sonnet", reasoning: false, contextWindow: 200_000 },
        { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: false, contextWindow: 128_000 },
    ],
};

function mockFetch() {
    const fetchMock = mock(async () => ({
        ok: true,
        json: async () => sampleModels,
    })) as any;
    (globalThis as any).fetch = fetchMock;
    return fetchMock;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderPanel(tuiSettings: Record<string, unknown> = {}, onSave = (_k: string, _v: unknown) => {}) {
    return render(
        <ModelsSettings
            {...({
                runnerId: "runner-1",
                config: {},
                tuiSettings,
                onSave,
                saving: false,
            } as any)}
        />,
    );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("ModelsSettings", () => {
    test("renders fallback models from tuiSettings", async () => {
        mockFetch();
        const { getByText, queryByText } = renderPanel({ fallbackModels: ["openai-codex:gpt-5.5"] });

        await waitFor(() => expect(getByText("Fallback Models")).toBeDefined());
        expect(queryByText("No fallback models configured.")).toBeNull();
    });

    test("saves fallback models in provider:modelId form", async () => {
        mockFetch();
        const saves: Array<{ section: string; value: any }> = [];
        const onSave = (section: string, value: unknown) => {
            saves.push({ section, value });
        };

        const { getByText } = renderPanel(
            {
                defaultProvider: "anthropic",
                defaultModel: "claude-sonnet-4-5",
                fallbackModels: ["openai-codex:gpt-5.5"],
            },
            onSave,
        );

        await waitFor(() => expect(getByText("Add fallback")).toBeDefined());
        getByText("Add fallback").click();

        await waitFor(() => expect(getByText("Save")).toBeDefined());
        getByText("Save").click();

        expect(saves.length).toBe(1);
        expect(saves[0].section).toBe("models");
        expect(saves[0].value.fallbackModels).toEqual(["openai-codex:gpt-5.5", "anthropic:claude-sonnet-4-5"]);
    });
});
