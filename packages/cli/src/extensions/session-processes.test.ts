import { describe, test, expect } from "bun:test";
import { formatWidgetLine, sessionProcessesExtension, shortCommand, type GroupProcess } from "./session-processes.js";

const proc = (pid: number, command: string): GroupProcess => ({ pid, etime: "01:00", rssKb: 1024, command });

describe("shortCommand", () => {
    test("basename + first non-flag arg", () => {
        expect(shortCommand("/usr/local/bin/bun run dev")).toBe("bun run");
        expect(shortCommand("node /app/server.js")).toBe("node server.js");
        expect(shortCommand("sleep 30")).toBe("sleep 30");
        expect(shortCommand("pgrep -g 0")).toBe("pgrep");
    });
});

describe("sessionProcessesExtension", () => {
    test("session_start is a no-op outside TUI mode (runner workers stub ui.theme)", () => {
        const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
        sessionProcessesExtension({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any);

        let widgetCalls = 0;
        // Mirrors the runner worker's headless ui stub: hasUI true, theme undefined.
        const ctx = {
            mode: "rpc",
            hasUI: true,
            ui: { setWidget: () => { widgetCalls++; }, get theme() { return undefined; } },
        };
        expect(() => handlers.session_start({}, ctx)).not.toThrow();
        expect(widgetCalls).toBe(0);
        handlers.session_shutdown({}, ctx);
    });
});

describe("formatWidgetLine", () => {
    test("null when only self is in the group", () => {
        expect(formatWidgetLine([proc(100, "pi")], 100)).toBeNull();
        expect(formatWidgetLine([], 100)).toBeNull();
    });

    test("lists children excluding self, with overflow count", () => {
        const procs = [proc(100, "pi"), proc(1, "bun run dev"), proc(2, "vite"), proc(3, "a"), proc(4, "b"), proc(5, "c"), proc(6, "d")];
        const line = formatWidgetLine(procs, 100);
        expect(line).toContain("6 procs");
        expect(line).toContain("bun run:1");
        expect(line).toContain("+2");
        expect(line).not.toContain(":100");
    });
});
