/**
 * Tests for the mode-wide scheduled-work surface.
 */
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { ModeSchedule, fetchScheduledInstructions } = await import("./ModeSchedule");

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
});

describe("fetchScheduledInstructions", () => {
    beforeEach(() => {
        globalThis.fetch = (async (input: any) => {
            const url = String(input);
            if (url.includes("sess-1")) {
                return new Response(JSON.stringify({
                    subscriptions: [
                        { subscriptionId: "a", triggerType: "time:cron", params: { cron: "0 8 * * *" } },
                        { subscriptionId: "b", triggerType: "github:pr_comment" },
                    ],
                }));
            }
            if (url.includes("sess-2")) {
                return new Response(JSON.stringify({
                    subscriptions: [{ subscriptionId: "c", triggerType: "time:at", params: { at: "9:00" } }],
                }));
            }
            return new Response(JSON.stringify({ subscriptions: [] }));
        }) as typeof fetch;
    });

    test("collects time-based subscriptions across sessions and drops the rest", async () => {
        const found = await fetchScheduledInstructions([
            { sessionId: "sess-1", sessionName: "One" },
            { sessionId: "sess-2", sessionName: "Two" },
        ]);
        expect(found.map((f) => f.subscriptionId)).toEqual(["a", "c"]);
        expect(found[0]!.sessionName).toBe("One");
    });

    test("an unreachable session does not blank the whole schedule", async () => {
        globalThis.fetch = (async (input: any) => {
            if (String(input).includes("sess-1")) throw new Error("offline");
            return new Response(JSON.stringify({
                subscriptions: [{ subscriptionId: "c", triggerType: "time:cron", params: { cron: "0 9 * * *" } }],
            }));
        }) as typeof fetch;

        const found = await fetchScheduledInstructions([
            { sessionId: "sess-1", sessionName: "One" },
            { sessionId: "sess-2", sessionName: "Two" },
        ]);
        expect(found.map((f) => f.subscriptionId)).toEqual(["c"]);
    });

    test("a non-ok response contributes nothing", async () => {
        globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
        expect(await fetchScheduledInstructions([{ sessionId: "s", sessionName: null }])).toEqual([]);
    });
});

describe("ModeSchedule", () => {
    const noop = () => {};
    const instruction = {
        sessionId: "s1",
        sessionName: "Daily report",
        subscriptionId: "sub-1",
        triggerType: "time:cron",
        params: { cron: "0 8 * * *", message: "Write my daily report" },
    };

    test("describes what runs and when", () => {
        const { getByText } = render(
            <ModeSchedule instructions={[instruction]} sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(getByText("Write my daily report")).toBeDefined();
        expect(getByText("Every day at 08:00")).toBeDefined();
    });

    test("renders nothing when there is no scheduled work", () => {
        const { container } = render(
            <ModeSchedule instructions={[]} sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(container.textContent).toBe("");
    });

    test("shows a loading state instead of an empty list", () => {
        const { getByText } = render(
            <ModeSchedule instructions={[]} loading sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(getByText(/Checking scheduled work/i)).toBeDefined();
    });

    test("opens the owning session and cancels the instruction", () => {
        const opened: string[] = [];
        const cancelled: unknown[] = [];
        const { getByText, getByLabelText } = render(
            <ModeSchedule
                instructions={[instruction]}
                sessionNoun="task"
                onOpenSession={(id) => opened.push(id)}
                onCancel={(i) => cancelled.push(i)}
            />,
        );
        fireEvent.click(getByText("Daily report"));
        expect(opened).toEqual(["s1"]);
        fireEvent.click(getByLabelText(/Cancel Every day at 08:00/i));
        expect(cancelled).toEqual([instruction]);
    });

    test("an instruction with no message still says what it does", () => {
        const { getByText } = render(
            <ModeSchedule
                instructions={[{ ...instruction, params: { cron: "0 8 * * *" } }]}
                sessionNoun="task"
                onOpenSession={noop}
                onCancel={noop}
            />,
        );
        expect(getByText("Wakes this task")).toBeDefined();
    });
});
