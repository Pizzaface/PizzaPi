/**
 * Plan mode must not relax bash filesystem checks just because the sandbox
 * reports active: the live bash tool (background-bash.ts) spawns commands
 * directly, without the sandbox wrapCommand that would apply the read-only
 * overlay. Runs in its own process (module mock).
 */
import { afterEach, expect, mock, test } from "bun:test";

const real = await import("@pizzapi/tools");
const overlayCalls: boolean[] = [];
mock.module("@pizzapi/tools", () => ({
    ...real,
    isSandboxActive: () => true,
    setReadOnlyOverlay: (enabled: boolean) => { overlayCalls.push(enabled); },
}));

const { planModeToggleExtension, setPlanModeFromRemote } = await import("./extension.js");

afterEach(() => setPlanModeFromRemote(false));

test("filesystem-mutating bash commands stay blocked in plan mode even when the sandbox is active", async () => {
    const handlers = new Map<string, Array<(e: any, c?: any) => unknown>>();
    const pi = {
        on: (ev: string, h: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
        registerCommand() {}, registerTool() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
    };
    planModeToggleExtension(pi as any);
    const emit = async (ev: string, payload: any, ctx?: any) => {
        let out: any;
        for (const h of handlers.get(ev) ?? []) { const r = await h(payload, ctx); if (r !== undefined) out = r; }
        return out;
    };
    const entries = [{ type: "custom", customType: "plan-mode-toggle", data: { enabled: true } }];
    await emit("session_start", { reason: "resume" }, { sessionManager: { getEntries: () => entries } });
    // Resume re-applies the overlay for sandboxed tools that do honour it.
    expect(overlayCalls.at(-1)).toBe(true);

    for (const command of ["rm -rf src", "echo x > file.txt", "sed -i 's/a/b/' f", "npm install", "touch x"]) {
        expect((await emit("tool_call", { toolName: "bash", input: { command } }))?.block).toBe(true);
    }
    expect(await emit("tool_call", { toolName: "bash", input: { command: "git status" } })).toBeUndefined();
});
