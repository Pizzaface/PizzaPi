import { describe, expect, test } from "bun:test";
import { TerminalService } from "./terminal-service.js";

function createFakeSocket() {
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const emitted: { event: string; data: any }[] = [];

    return {
        on(event: string, fn: (...args: any[]) => void) {
            const list = listeners.get(event) ?? [];
            list.push(fn);
            listeners.set(event, list);
        },
        off(event: string, fn: (...args: any[]) => void) {
            const list = listeners.get(event) ?? [];
            listeners.set(event, list.filter((f) => f !== fn));
        },
        emit(event: string, data: any) {
            emitted.push({ event, data });
        },
        listeners,
        emitted,
        trigger(event: string, data: any) {
            for (const fn of listeners.get(event) ?? []) fn(data);
        },
        serviceMessages() {
            return emitted.filter((e) => e.event === "service_message").map((e) => e.data);
        },
    };
}

describe("TerminalService", () => {
    test("scopes service_message errors to the request session", () => {
        const socket = createFakeSocket();
        const service = new TerminalService();
        service.init(socket as any, { isShuttingDown: () => false });

        socket.trigger("new_terminal", { terminalId: "", sessionId: "session-a" });

        expect(socket.serviceMessages()).toEqual([
            {
                serviceId: "terminal",
                type: "terminal_error",
                sessionId: "session-a",
                payload: { terminalId: "", message: "Missing terminalId" },
            },
        ]);
        service.dispose();
    });
});
