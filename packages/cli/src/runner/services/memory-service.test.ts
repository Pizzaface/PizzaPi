import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "./memory-service.js";

function makeSocket() {
    const handlers = new Map<string, (env: any) => void>();
    const emitted: any[] = [];
    return {
        handlers,
        emitted,
        on(event: string, h: (env: any) => void) {
            handlers.set(event, h);
        },
        off() {},
        emit(_event: string, envelope: any) {
            emitted.push(envelope);
        },
    };
}

describe("MemoryService", () => {
    test("responses carry the requesting session's top-level sessionId (no runner-wide broadcast)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "memory-service-test-"));
        try {
            const service = new MemoryService((sessionId) => (sessionId === "sess-1" ? cwd : null));
            const socket = makeSocket();
            service.init(socket as any, { isShuttingDown: () => false } as any);

            socket.handlers.get("service_message")!({
                serviceId: "memory",
                type: "memory_list",
                requestId: "req-1",
                sessionId: "sess-1",
                payload: {},
            });

            expect(socket.emitted).toHaveLength(1);
            expect(socket.emitted[0].type).toBe("memory_list_result");
            // Regression: without a top-level sessionId the relay broadcasts
            // this response to every session on the runner.
            expect(socket.emitted[0].sessionId).toBe("sess-1");

            // Error responses are session-scoped too.
            socket.handlers.get("service_message")!({
                serviceId: "memory",
                type: "memory_read",
                requestId: "req-2",
                sessionId: "sess-unknown",
                payload: {},
            });
            expect(socket.emitted[1].type).toBe("memory_error");
            expect(socket.emitted[1].sessionId).toBe("sess-unknown");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
