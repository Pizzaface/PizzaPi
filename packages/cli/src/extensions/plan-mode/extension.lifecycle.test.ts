/**
 * Lifecycle tests for the plan-mode extension: tool_call enforcement across
 * session start / resume / switch / new-session boundaries (F21).
 *
 * Drives the real extension factory with a minimal pi stub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { planModeToggleExtension, isPlanModeEnabled, setPlanModeFromRemote } from "./extension.js";

type Handler = (event: any, ctx?: any) => unknown;

function createHarness() {
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, any>();
    const appended: any[] = [];
    const pi = {
        on(event: string, handler: Handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        registerCommand() {},
        registerTool(def: any) { tools.set(def.name, def); },
        appendEntry(customType: string, data: unknown) { appended.push({ type: "custom", customType, data }); },
        sendMessage() {},
        sendUserMessage() {},
    };
    planModeToggleExtension(pi as any);

    /** Dispatch like pi's runner: every handler, in registration order. */
    async function emit(event: string, payload: any, ctx?: any) {
        let result: unknown;
        for (const h of handlers.get(event) ?? []) {
            const r = await h(payload, ctx);
            if (r !== undefined) result = r;
        }
        return result as { block?: boolean; reason?: string } | undefined;
    }

    const sessionCtx = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } });
    const toolCall = (toolName: string, input: Record<string, unknown> = {}) =>
        emit("tool_call", { type: "tool_call", toolName, toolCallId: "t1", input });

    return { emit, tools, appended, sessionCtx, toolCall };
}

const planEntry = (enabled: boolean) => ({ type: "custom", customType: "plan-mode-toggle", data: { enabled, todos: [], executing: false } });

afterEach(() => {
    // Leave module-level state clean for other suites.
    setPlanModeFromRemote(false);
});

describe("F21 — persisted plan mode survives session start / resume", () => {
    for (const reason of ["startup", "resume", "reload", "fork"]) {
        test(`session_start(${reason}) with an enabled transcript keeps plan mode ON and blocks the first mutating call`, async () => {
            const h = createHarness();
            await h.emit("session_start", { type: "session_start", reason }, h.sessionCtx([planEntry(true)]));

            expect(isPlanModeEnabled()).toBe(true);
            expect((await h.toolCall("edit", { path: "a", edits: [] }))?.block).toBe(true);
            expect((await h.toolCall("write", { path: "a", content: "" }))?.block).toBe(true);
            expect((await h.toolCall("bash", { command: "rm -rf src" }))?.block).toBe(true);
            // Read-only tools still work.
            expect(await h.toolCall("read", { path: "a" })).toBeUndefined();
            expect(await h.toolCall("bash", { command: "git status" })).toBeUndefined();
        });
    }

    test("session_start does not persist a spurious 'disabled' entry over the restored state", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));
        expect(h.appended.some((e) => e.data?.enabled === false)).toBe(false);
    });

    test("the latest persisted entry wins (enabled → disabled)", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "resume" }, h.sessionCtx([planEntry(true), planEntry(false)]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });

    test("a genuinely new session starts with plan mode OFF even if the previous one had it ON", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));
        expect(isPlanModeEnabled()).toBe(true);

        await h.emit("session_start", { type: "session_start", reason: "new" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });

    test("worker session_switch(resume) into a plan-mode transcript re-enables enforcement before the next call", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);

        await h.emit("session_switch", { type: "session_switch", reason: "resume" }, h.sessionCtx([planEntry(true)]));
        expect(isPlanModeEnabled()).toBe(true);
        expect((await h.toolCall("edit", { path: "a" }))?.block).toBe(true);

        // …and switching to a new, empty session clears it again.
        await h.emit("session_switch", { type: "session_switch", reason: "new" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });
});
