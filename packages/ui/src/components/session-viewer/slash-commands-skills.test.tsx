/**
 * `/skills` is handled in the browser (it renders the runner's skill list), but
 * `/skills reload` must fall through to the CLI extension command instead.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).requestAnimationFrame = (() => 0) as any;

const { renderHook, act, cleanup } = await import("@testing-library/react");
const { useSlashCommands } = await import("./slash-commands");
import type { SlashCommandDeps } from "./slash-commands";

afterEach(cleanup);

function setup(input: string) {
    const systemMessages: unknown[] = [];
    const deps: SlashCommandDeps = {
        sessionId: "sess-1",
        sessionIdRef: { current: "sess-1" },
        compactingRef: { current: false },
        runnerInfo: { skills: [{ name: "demo", description: "A demo skill" }] } as any,
        onAppendSystemMessage: (content) => systemMessages.push(content),
        skillCommands: [],
        extensionCommands: [],
        promptCommands: [],
        onIncompleteTriggers: () => {},
    };
    const view = renderHook(() => useSlashCommands(input, () => {}, deps));
    return { view, systemMessages };
}

describe("/skills", () => {
    test("bare /skills is handled in the browser", () => {
        const { view, systemMessages } = setup("/skills");
        let handled = false;
        act(() => { handled = view.result.current.executeSlashCommand("/skills"); });
        expect(handled).toBe(true);
        expect(systemMessages).toHaveLength(1);
    });

    test("/skills reload falls through to the CLI", () => {
        const { view, systemMessages } = setup("/skills reload");
        let handled = true;
        act(() => { handled = view.result.current.executeSlashCommand("/skills reload"); });
        expect(handled).toBe(false);
        expect(systemMessages).toHaveLength(0);
    });

    test("/skills list renders the listing in the browser", () => {
        const { view, systemMessages } = setup("/skills list");
        let handled = false;
        act(() => { handled = view.result.current.executeSlashCommand("/skills list"); });
        expect(handled).toBe(true);
        expect(systemMessages).toHaveLength(1);
    });

    test("the picker offers list first, then reload", () => {
        const { view } = setup("/skills ");
        const skills = view.result.current.supportedWebCommands.find((c) => c.name === "skills");
        expect(skills?.subCommands?.map((s) => s.name)).toEqual(["list", "reload"]);
        // Enter with nothing typed runs the highlighted (first) entry.
        expect(view.result.current.subCommandMode.filtered[0]?.name).toBe("list");
    });
});
