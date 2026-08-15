/**
 * Tests for ModeHome — the composer-first landing shown when a mode is
 * selected and no session is open.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { resolveModeUi } from "@pizzapi/protocol";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { ModeHome, formatWhen } = await import("./ModeHome");

// NOTE: React's synthetic input/change events do not reach handlers under this
// happy-dom harness (click does), so the composer cannot be typed into here.
// The submit path is exercised through a suggestion chip, which fills the same
// draft state via a click.

const workUi = resolveModeUi({
    id: "work",
    label: "Work",
    workspace: "/w",
    ui: {
        preset: "work",
        vocabulary: { session: "task", sessions: "tasks" },
        composerPlaceholder: "What do you need done?",
        home: {
            greeting: "What are we working on?",
            suggestions: [{ label: "Daily report", prompt: "Write my daily report" }],
        },
    },
});

const noop = () => {};

afterEach(() => cleanup());

describe("ModeHome", () => {
    test("greets with the mode's own words", () => {
        const { getByText, getByPlaceholderText } = render(
            <ModeHome modeLabel="Work" modeUi={workUi} recentSessions={[]} onStartTask={noop} onOpenSession={noop} />,
        );
        expect(getByText("What are we working on?")).toBeDefined();
        expect(getByPlaceholderText("What do you need done?")).toBeDefined();
    });

    test("starts a task with the composed prompt", () => {
        const started: string[] = [];
        const { getByRole } = render(
            <ModeHome
                modeLabel="Work"
                modeUi={workUi}
                recentSessions={[]}
                onStartTask={(p) => started.push(p)}
                onOpenSession={noop}
            />,
        );
        fireEvent.click(getByRole("button", { name: "Daily report" }));
        fireEvent.click(getByRole("button", { name: /new task/i }));
        expect(started).toEqual(["Write my daily report"]);
    });

    test("an empty prompt cannot start a task", () => {
        const started: string[] = [];
        const { getByPlaceholderText, getByRole } = render(
            <ModeHome
                modeLabel="Work"
                modeUi={workUi}
                recentSessions={[]}
                onStartTask={(p) => started.push(p)}
                onOpenSession={noop}
            />,
        );
        fireEvent.keyDown(getByPlaceholderText("What do you need done?"), { key: "Enter" });
        expect(started).toEqual([]);
        expect((getByRole("button", { name: /new task/i }) as unknown as HTMLButtonElement).disabled).toBe(true);
    });

    test("a suggestion prefills the composer rather than starting work", () => {
        const started: string[] = [];
        const { getByRole, getByPlaceholderText } = render(
            <ModeHome
                modeLabel="Work"
                modeUi={workUi}
                recentSessions={[]}
                onStartTask={(p) => started.push(p)}
                onOpenSession={noop}
            />,
        );
        fireEvent.click(getByRole("button", { name: "Daily report" }));
        expect(started).toEqual([]);
        expect((getByPlaceholderText("What do you need done?") as unknown as HTMLTextAreaElement).value).toBe(
            "Write my daily report",
        );
    });

    test("recent tasks use the mode's vocabulary and open on click", () => {
        const opened: string[] = [];
        const { getByText } = render(
            <ModeHome
                modeLabel="Work"
                modeUi={workUi}
                recentSessions={[{
                    sessionId: "s1",
                    sessionName: "Q3 review",
                    cwd: "/w",
                    lastHeartbeatAt: new Date().toISOString(),
                    startedAt: new Date().toISOString(),
                    isActive: true,
                }]}
                onStartTask={noop}
                onOpenSession={(id) => opened.push(id)}
            />,
        );
        expect(getByText("Recent tasks")).toBeDefined();
        fireEvent.click(getByText("Q3 review"));
        expect(opened).toEqual(["s1"]);
    });

    test("while a task is starting the composer is locked", () => {
        const started: string[] = [];
        const { getByRole, getByPlaceholderText } = render(
            <ModeHome
                modeLabel="Work"
                modeUi={workUi}
                recentSessions={[]}
                onStartTask={(p) => started.push(p)}
                onOpenSession={noop}
                busy
            />,
        );
        expect((getByPlaceholderText("What do you need done?") as unknown as HTMLTextAreaElement).disabled).toBe(true);
        // A filled draft must not start a second task while one is starting.
        fireEvent.click(getByRole("button", { name: "Daily report" }));
        fireEvent.click(getByRole("button", { name: /new task/i }));
        expect(started).toEqual([]);
    });

    test("a mode with no suggestions or recents still renders the composer", () => {
        const bare = resolveModeUi({ id: "m", label: "M", workspace: "/m" });
        const { getByPlaceholderText } = render(
            <ModeHome modeLabel="M" modeUi={bare} recentSessions={[]} onStartTask={noop} onOpenSession={noop} />,
        );
        expect(getByPlaceholderText("Start a session…")).toBeDefined();
    });
});

describe("formatWhen", () => {
    test("renders recent times relatively", () => {
        expect(formatWhen(new Date().toISOString())).toBe("just now");
        expect(formatWhen(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
        expect(formatWhen(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h ago");
        expect(formatWhen(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d ago");
    });

    test("an unparseable timestamp renders nothing rather than NaN", () => {
        expect(formatWhen("not a date")).toBe("");
    });
});
