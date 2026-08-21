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
            if (url.includes("/api/runners/runner-A/schedules")) {
                return new Response(JSON.stringify({
                    schedules: [
                        { subscriptionId: "a", sessionId: "sess-1", sessionName: "One", triggerType: "time:cron", params: { cron: "0 8 * * *" }, cwd: "/work/a", sessionLive: true },
                        { subscriptionId: "c", sessionId: "sess-2", sessionName: null, triggerType: "time:at", params: { at: "9:00" }, cwd: "/work/b", sessionLive: false },
                        // Not a schedule — must not appear on the schedule surface.
                        { subscriptionId: "b", sessionId: "sess-1", triggerType: "github:pr_comment" },
                    ],
                }));
            }
            return new Response(JSON.stringify({ schedules: [] }));
        }) as typeof fetch;
    });

    test("lists a runner's schedules and drops non-schedule subscriptions", async () => {
        const { instructions, failed } = await fetchScheduledInstructions("runner-A");
        expect(instructions.map((f) => f.subscriptionId)).toEqual(["a", "c"]);
        expect(instructions[0]!.sessionName).toBe("One");
        expect(instructions[0]!.cwd).toBe("/work/a");
        expect(failed).toBe(0);
    });

    test("includes schedules whose owning session is no longer running", async () => {
        const { instructions } = await fetchScheduledInstructions("runner-A");
        const ownerless = instructions.find((i) => i.subscriptionId === "c");
        // The whole point of listing by runner: this one is invisible to any
        // per-session fan-out, but still fires and still needs cancelling.
        expect(ownerless).toBeDefined();
        expect(ownerless!.sessionLive).toBe(false);
    });

    test("no runner means nothing to ask, not a failure", async () => {
        expect(await fetchScheduledInstructions(null)).toEqual({ instructions: [], failed: 0 });
    });

    test("a non-ok response is reported rather than passed off as 'nothing scheduled'", async () => {
        globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
        expect(await fetchScheduledInstructions("runner-A")).toEqual({ instructions: [], failed: 1 });
    });

    test("a network error is reported too", async () => {
        globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
        expect(await fetchScheduledInstructions("runner-A")).toEqual({ instructions: [], failed: 1 });
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
        expect(getByText("Every day at 08:00 UTC")).toBeDefined();
    });

    test("renders nothing when there is no scheduled work", () => {
        const { container } = render(
            <ModeSchedule instructions={[]} sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(container.textContent).toBe("");
    });

    test("an all-failed check is not shown as an empty schedule", () => {
        const { getByText } = render(
            <ModeSchedule instructions={[]} failed={2} sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(getByText(/Could not check scheduled work for 2 tasks/i)).toBeDefined();
    });

    test("a partial failure warns that the list may be incomplete", () => {
        const { getByText } = render(
            <ModeSchedule instructions={[instruction]} failed={1} sessionNoun="task" onOpenSession={noop} onCancel={noop} />,
        );
        expect(getByText(/list may be incomplete/i)).toBeDefined();
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
        fireEvent.click(getByLabelText(/Cancel Every day at 08:00 UTC/i));
        expect(cancelled).toEqual([instruction]);
    });

    test("guards against concurrent cancellation while the request is pending", async () => {
        let resolveCancel!: () => void;
        const onCancel = () => new Promise<void>((resolve) => { resolveCancel = resolve; });
        const { getByLabelText } = render(
            <ModeSchedule instructions={[instruction]} sessionNoun="task" onOpenSession={noop} onCancel={onCancel} />,
        );
        const button = getByLabelText(/Cancel Every day at 08:00/i) as HTMLButtonElement;
        fireEvent.click(button);
        fireEvent.click(button);
        expect(button.disabled).toBe(true);
        resolveCancel();
        await new Promise((resolve) => queueMicrotask(resolve));
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
