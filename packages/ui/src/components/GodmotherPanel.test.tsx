import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";

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
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).window.SyntaxError = globalThis.SyntaxError;
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const channelState = {
    available: true,
};

const sendSpy = mock((_type: string, _payload: unknown, _requestId?: string) => {});

let capturedOnMessage:
    | ((type: string, payload: unknown, requestId?: string) => void)
    | undefined;

mock.module("@/hooks/useServiceChannel", () => ({
    useServiceChannel: (
        _serviceId: string,
        opts: { onMessage?: (type: string, payload: unknown, requestId?: string) => void } = {}
    ) => {
        capturedOnMessage = opts.onMessage;
        return { send: sendSpy, available: channelState.available };
    },
    getEagerServiceAvailability: () => false,
}));

afterAll(() => mock.restore());

const { GodmotherPanel } = await import("./GodmotherPanel");

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    sendSpy.mockClear();
    capturedOnMessage = undefined;
    channelState.available = true;
});

describe("GodmotherPanel", () => {
    test("requests ideas on mount when service is available", async () => {
        await act(async () => {
            render(<GodmotherPanel sessionId="sess" />);
        });

        const queryCall = sendSpy.mock.calls.find(([type]) => type === "ideas_query");
        expect(queryCall).toBeDefined();
        expect(typeof queryCall?.[2]).toBe("string");
    });

    test("renders status badge and topics from query result", async () => {
        let view!: ReturnType<typeof render>;
        await act(async () => {
            view = render(<GodmotherPanel sessionId="sess" />);
        });

        await act(async () => {
            capturedOnMessage?.(
                "godmother_query_result",
                {
                    ideas: [
                        {
                            id: "idea-1",
                            project: "PizzaPi",
                            status: "execute",
                            topics: ["runner", "ui"],
                            snippet: "Improve service panel UX",
                        },
                    ],
                },
                "gm-q-1",
            );
        });

        expect(view.getByText("#runner")).toBeTruthy();
        expect(view.getByText("#ui")).toBeTruthy();
        expect(view.getByText("Improve service panel UX")).toBeTruthy();
    });

    test("sends move status actions", async () => {
        let view!: ReturnType<typeof render>;
        await act(async () => {
            view = render(<GodmotherPanel sessionId="sess" />);
        });

        await act(async () => {
            capturedOnMessage?.(
                "godmother_query_result",
                {
                    ideas: [
                        {
                            id: "idea-1",
                            project: "PizzaPi",
                            status: "execute",
                            topics: ["runner"],
                            snippet: "Improve service panel UX",
                        },
                    ],
                },
                "gm-q-1",
            );
        });

        const moveSelect = view.getByLabelText("Move status for idea-1") as HTMLSelectElement;
        await act(async () => {
            fireEvent.change(moveSelect, { target: { value: "review" } });
        });

        const moveCall = sendSpy.mock.calls.find(([type]) => type === "idea_move_status");
        expect(moveCall).toBeDefined();
        expect(moveCall?.[1]).toEqual({ id: "idea-1", to: "review" });
    });
});
