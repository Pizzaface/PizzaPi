/**
 * Tests for the /rewind (fork) slash-command mode in useSlashCommands.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Window } from "happy-dom";

// ── DOM globals ─────────────────────────────────────────────────────────────
// Must be set BEFORE React or hook imports so module evaluation sees a browser
// environment.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
// No-op rAF shim — rewindToMessage schedules a focus/cursor callback we don't
// assert on. Deferring it (setTimeout) would fire after this file's DOM is
// torn down and crash the next test file; invoking it synchronously trips a
// happy-dom selector-parser incompatibility. Dropping it keeps tests hermetic.
(globalThis as any).requestAnimationFrame = (() => 0) as any;

const { renderHook, act, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useSlashCommands } = await import("./slash-commands");
import type { SlashCommandDeps } from "./slash-commands";
import type { ForkMessageOption } from "@/lib/types";

afterEach(cleanup);

function setup(options: {
    input: string;
    forkMessages?: ForkMessageOption[];
    onExec?: (payload: unknown) => boolean | void;
    onRequestForkMessages?: () => boolean | void;
}) {
    const setInputCalls: string[] = [];
    const deps: SlashCommandDeps = {
        sessionId: "sess-1",
        sessionIdRef: { current: "sess-1" },
        compactingRef: { current: false },
        onExec: options.onExec,
        forkMessages: options.forkMessages,
        onRequestForkMessages: options.onRequestForkMessages,
        skillCommands: [],
        extensionCommands: [],
        promptCommands: [],
        onIncompleteTriggers: () => {},
    };
    const view = renderHook(
        ({ input }: { input: string }) =>
            useSlashCommands(input, (v) => setInputCalls.push(v), deps),
        { initialProps: { input: options.input } },
    );
    return { view, setInputCalls };
}

const messages: ForkMessageOption[] = [
    { entryId: "e1", text: "first question" },
    { entryId: "e2", text: "second question" },
    { entryId: "e3", text: "third about CSS" },
];

describe("rewind mode", () => {
    test("activates for /rewind and /fork, not for other commands", () => {
        expect(setup({ input: "/rewind" }).view.result.current.isRewindMode).toBe(true);
        expect(setup({ input: "/fork " }).view.result.current.isRewindMode).toBe(true);
        expect(setup({ input: "/resume" }).view.result.current.isRewindMode).toBe(false);
        expect(setup({ input: "/rewindx" }).view.result.current.isRewindMode).toBe(false);
    });

    test("candidates are newest-first and filtered by query", () => {
        const { view } = setup({ input: "/rewind", forkMessages: messages });
        expect(view.result.current.rewindCandidates.map((m) => m.entryId)).toEqual(["e3", "e2", "e1"]);

        view.rerender({ input: "/rewind css" });
        expect(view.result.current.rewindCandidates.map((m) => m.entryId)).toEqual(["e3"]);
    });

    test("requests fork messages when the picker opens in rewind mode", () => {
        let requests = 0;
        const { view } = setup({
            input: "/rewind",
            onRequestForkMessages: () => {
                requests += 1;
            },
        });
        act(() => view.result.current.setCommandOpen(true));
        expect(requests).toBe(1);
    });

    test("rewindToMessage dispatches fork exec and pre-fills the composer", () => {
        const execs: any[] = [];
        const { view, setInputCalls } = setup({
            input: "/rewind",
            forkMessages: messages,
            onExec: (payload) => {
                execs.push(payload);
                return true;
            },
        });

        act(() => view.result.current.rewindToMessage(messages[1]!));

        expect(execs).toHaveLength(1);
        expect(execs[0].command).toBe("fork");
        expect(execs[0].entryId).toBe("e2");
        expect(setInputCalls.at(-1)).toBe("second question");
    });

    test("executeSlashCommand with a bare /rewind keeps the picker open instead of forking", () => {
        const execs: any[] = [];
        const { view } = setup({
            input: "/rewind",
            forkMessages: messages,
            onExec: (payload) => {
                execs.push(payload);
                return true;
            },
        });

        let handled = false;
        act(() => {
            handled = view.result.current.executeSlashCommand("/rewind");
        });

        expect(handled).toBe(true);
        expect(execs).toHaveLength(0);
        expect(view.result.current.commandOpen).toBe(true);
    });

    test("executeSlashCommand with a query forks the newest matching message", () => {
        const execs: any[] = [];
        const { view } = setup({
            input: "/rewind question",
            forkMessages: messages,
            onExec: (payload) => {
                execs.push(payload);
                return true;
            },
        });

        act(() => {
            view.result.current.executeSlashCommand("/rewind question");
        });

        // Newest match wins: e2 ("second question"), not e1
        expect(execs).toHaveLength(1);
        expect(execs[0].entryId).toBe("e2");
    });
});
