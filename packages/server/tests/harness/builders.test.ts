/**
 * Tests for event builders and mock relay integration.
 */

import { describe, test, expect } from "bun:test";

// Skip integration tests in CI — createTestServer() uses module-level singletons
// that race when Bun runs test files in parallel.
const isCI = !!process.env.CI;
import {
    buildHeartbeat,
    buildAssistantMessage,
    buildToolUseEvent,
    buildToolResultEvent,
    buildConversation,
    buildSessionInfo,
    buildRunnerInfo,
    buildMetaState,
    buildTodoList,
} from "./builders.js";
import { createTestServer } from "./server.js";
import { createMockRelay } from "./mock-relay.js";
import { defaultMetaState } from "@pizzapi/protocol";

const TEST_TIMEOUT_MS = 30_000;

// ── buildHeartbeat ────────────────────────────────────────────────────────────

describe("buildHeartbeat", () => {
    test("produces a valid default heartbeat", () => {
        const hb = buildHeartbeat();
        expect(hb.type).toBe("heartbeat");
        expect(typeof hb.active).toBe("boolean");
        expect(typeof hb.isCompacting).toBe("boolean");
        expect(typeof hb.ts).toBe("number");
        expect(hb.ts).toBeGreaterThan(0);
        expect(hb.model).toBeNull();
        expect(hb.sessionName).toBeNull();
        expect(hb.uptime).toBeNull();
        expect(typeof hb.cwd).toBe("string");
    });

    test("applies overrides correctly", () => {
        const hb = buildHeartbeat({
            active: true,
            isCompacting: true,
            sessionName: "My Session",
            cwd: "/home/user",
            model: { provider: "anthropic", id: "claude-3-5-haiku-20241022" },
        });
        expect(hb.active).toBe(true);
        expect(hb.isCompacting).toBe(true);
        expect(hb.sessionName).toBe("My Session");
        expect(hb.cwd).toBe("/home/user");
        expect(hb.model?.provider).toBe("anthropic");
        expect(hb.type).toBe("heartbeat"); // immutable
    });

    test("ts override is respected", () => {
        const ts = 12345678;
        const hb = buildHeartbeat({ ts });
        expect(hb.ts).toBe(ts);
    });
});

// ── buildAssistantMessage ─────────────────────────────────────────────────────

describe("buildAssistantMessage", () => {
    test("produces correct shape", () => {
        const msg = buildAssistantMessage("Hello, world!");
        expect(msg.type).toBe("message_update");
        expect(msg.role).toBe("assistant");
        expect(msg.content).toHaveLength(1);
        expect(msg.content[0].type).toBe("text");
        expect(msg.content[0].text).toBe("Hello, world!");
        expect(typeof msg.messageId).toBe("string");
    });

    test("applies overrides", () => {
        const msg = buildAssistantMessage("Hi", { messageId: "custom-id-123" });
        expect(msg.messageId).toBe("custom-id-123");
    });
});

// ── buildToolUseEvent ─────────────────────────────────────────────────────────

describe("buildToolUseEvent", () => {
    test("produces correct shape", () => {
        const block = buildToolUseEvent("Bash", { command: "ls" });
        expect(block.type).toBe("tool_use");
        expect(block.name).toBe("Bash");
        expect(block.input).toEqual({ command: "ls" });
        expect(typeof block.id).toBe("string");
        expect(block.id.length).toBeGreaterThan(0);
    });

    test("uses provided toolCallId", () => {
        const block = buildToolUseEvent("Read", { path: "/tmp/foo" }, "my-tool-id");
        expect(block.id).toBe("my-tool-id");
    });
});

// ── buildToolResultEvent ──────────────────────────────────────────────────────

describe("buildToolResultEvent", () => {
    test("produces correct shape", () => {
        const result = buildToolResultEvent("tool-abc", "output text");
        expect(result.type).toBe("tool_result");
        expect(result.tool_use_id).toBe("tool-abc");
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toBe("output text");
    });
});

// ── buildConversation ─────────────────────────────────────────────────────────

describe("buildConversation", () => {
    test("empty conversation yields empty array", () => {
        expect(buildConversation([])).toEqual([]);
    });

    test("user turn produces harness:user_turn marker (not a real protocol event)", () => {
        const events = buildConversation([{ role: "user", text: "hello" }]) as Array<Record<string, unknown>>;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("harness:user_turn");
        expect(events[0].text).toBe("hello");
    });

    test("assistant text turn produces message_update event", () => {
        const events = buildConversation([
            { role: "assistant", text: "Hi there" },
        ]) as Array<Record<string, unknown>>;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("message_update");
        const msg = events[0] as { role: string; content: Array<{ text: string }> };
        expect(msg.role).toBe("assistant");
        expect(msg.content[0].text).toBe("Hi there");
    });

    test("assistant toolCall turn produces tool_use content block", () => {
        const events = buildConversation([
            { role: "assistant", toolCall: { name: "Bash", input: { command: "pwd" } } },
        ]) as Array<{ type: string; content: Array<{ type: string; name: string }> }>;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("message_update");
        expect(events[0].content[0].type).toBe("tool_use");
        expect(events[0].content[0].name).toBe("Bash");
    });

    test("tool turn produces tool_result_message event", () => {
        const events = buildConversation([
            { role: "tool", toolCallId: "t-1", result: "success" },
        ]) as Array<{ type: string; content: Array<{ tool_use_id: string }> }>;
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("tool_result_message");
        expect(events[0].content[0].tool_use_id).toBe("t-1");
    });

    test("multi-turn conversation produces correct sequence", () => {
        const events = buildConversation([
            { role: "user", text: "What is 2+2?" },
            { role: "assistant", text: "4" },
            { role: "user", text: "Thanks" },
        ]) as Array<Record<string, unknown>>;
        expect(events).toHaveLength(3);
        expect(events[0].type).toBe("harness:user_turn");
        expect(events[1].type).toBe("message_update");
        expect(events[2].type).toBe("harness:user_turn");
    });
});

// ── buildSessionInfo ──────────────────────────────────────────────────────────

describe("buildSessionInfo", () => {
    test("produces valid defaults", () => {
        const info = buildSessionInfo();
        expect(typeof info.sessionId).toBe("string");
        expect(typeof info.shareUrl).toBe("string");
        expect(typeof info.cwd).toBe("string");
        expect(typeof info.startedAt).toBe("string");
        expect(info.isEphemeral).toBe(true);
        expect(info.isActive).toBe(true);
        expect(info.model).toBeNull();
        expect(info.runnerId).toBeNull();
        expect(info.sessionName).toBeNull();
    });

    test("applies overrides", () => {
        const info = buildSessionInfo({
            sessionId: "my-session-id",
            sessionName: "Test Session",
            isActive: false,
            isEphemeral: false,
        });
        expect(info.sessionId).toBe("my-session-id");
        expect(info.sessionName).toBe("Test Session");
        expect(info.isActive).toBe(false);
        expect(info.isEphemeral).toBe(false);
    });

    test("two calls produce different sessionIds by default", () => {
        const a = buildSessionInfo();
        const b = buildSessionInfo();
        expect(a.sessionId).not.toBe(b.sessionId);
    });
});

// ── buildRunnerInfo ───────────────────────────────────────────────────────────

describe("buildRunnerInfo", () => {
    test("produces valid defaults", () => {
        const info = buildRunnerInfo();
        expect(typeof info.runnerId).toBe("string");
        expect(typeof info.name).toBe("string");
        expect(Array.isArray(info.roots)).toBe(true);
        expect(Array.isArray(info.skills)).toBe(true);
        expect(Array.isArray(info.agents)).toBe(true);
        expect(info.sessionCount).toBe(0);
    });

    test("applies overrides", () => {
        const info = buildRunnerInfo({ name: "Production Runner", sessionCount: 3 });
        expect(info.name).toBe("Production Runner");
        expect(info.sessionCount).toBe(3);
    });
});

// ── buildMetaState ────────────────────────────────────────────────────────────

describe("buildMetaState", () => {
    test("matches defaultMetaState structure", () => {
        const meta = buildMetaState();
        const defaults = defaultMetaState();
        // All keys from defaultMetaState should be present
        for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
            expect(meta).toHaveProperty(key);
        }
    });

    test("default version is 0", () => {
        const meta = buildMetaState();
        expect(meta.version).toBe(0);
    });

    test("default fields match defaultMetaState values", () => {
        const meta = buildMetaState();
        const defaults = defaultMetaState();
        expect(meta.todoList).toEqual(defaults.todoList);
        expect(meta.pendingQuestion).toBe(defaults.pendingQuestion);
        expect(meta.pendingPlan).toBe(defaults.pendingPlan);
        expect(meta.planModeEnabled).toBe(defaults.planModeEnabled);
        expect(meta.isCompacting).toBe(defaults.isCompacting);
    });

    test("applies overrides", () => {
        const meta = buildMetaState({
            planModeEnabled: true,
            isCompacting: true,
            version: 42,
        });
        expect(meta.planModeEnabled).toBe(true);
        expect(meta.isCompacting).toBe(true);
        expect(meta.version).toBe(42);
    });
});

// ── buildTodoList ─────────────────────────────────────────────────────────────

describe("buildTodoList", () => {
    test("returns empty array for empty input", () => {
        expect(buildTodoList([])).toEqual([]);
    });

    test("produces correct shape with auto-incremented IDs starting at 1", () => {
        const items = buildTodoList([
            { text: "Task one" },
            { text: "Task two" },
            { text: "Task three" },
        ]);
        expect(items).toHaveLength(3);
        expect(items[0]).toEqual({ id: 1, text: "Task one", status: "pending" });
        expect(items[1]).toEqual({ id: 2, text: "Task two", status: "pending" });
        expect(items[2]).toEqual({ id: 3, text: "Task three", status: "pending" });
    });

    test("respects provided status", () => {
        const items = buildTodoList([
            { text: "Done task", status: "done" },
            { text: "Active task", status: "in_progress" },
        ]);
        expect(items[0].status).toBe("done");
        expect(items[1].status).toBe("in_progress");
    });

    test("defaults missing status to pending", () => {
        const items = buildTodoList([{ text: "A task" }]);
        expect(items[0].status).toBe("pending");
    });
});

// ── Integration: MockRelay + builders ─────────────────────────────────────────
// NOTE: createTestServer() uses module-level singletons (auth, sio-state).
// These integration tests are serialized to avoid conflicts, and each test
// disconnects the relay socket before calling server.cleanup() so that
// io.close() can complete cleanly.

(isCI ? describe.skip : describe.serial)("MockRelay integration", () => {
    test("connect, register, emit event, disconnect", async () => {
        const server = await createTestServer();
        let relay;
        try {
            relay = await createMockRelay(server);
            expect(relay.socket.connected).toBe(true);

            const session = await relay.registerSession({ cwd: "/tmp/test" });
            expect(typeof session.sessionId).toBe("string");
            expect(session.sessionId.length).toBeGreaterThan(0);
            expect(typeof session.token).toBe("string");
            expect(session.token.length).toBeGreaterThan(0);
            expect(typeof session.shareUrl).toBe("string");

            // Emit a heartbeat event through the relay
            const hb = buildHeartbeat({ active: true, cwd: "/tmp/test" });
            relay.emitEvent(session.sessionId, session.token, hb, 1);

            // Give the server a moment to process
            await Bun.sleep(100);

            // Signal session end
            relay.emitSessionEnd(session.sessionId, session.token);
            await Bun.sleep(50);

            await relay.disconnect();
            expect(relay.socket.connected).toBe(false);
        } finally {
            // Disconnect relay before cleanup so io.close() can drain cleanly
            if (relay && relay.socket.connected) {
                await relay.disconnect().catch(() => {});
            }
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("can register multiple sessions on the same relay", async () => {
        const server = await createTestServer();
        let relay;
        try {
            relay = await createMockRelay(server);

            const s1 = await relay.registerSession({ cwd: "/tmp/s1" });
            const s2 = await relay.registerSession({ cwd: "/tmp/s2" });

            expect(s1.sessionId).not.toBe(s2.sessionId);
            expect(s1.token).not.toBe(s2.token);

            // Emit events for both sessions
            const hb = buildHeartbeat({ active: false });
            relay.emitEvent(s1.sessionId, s1.token, hb);
            relay.emitEvent(s2.sessionId, s2.token, hb);

            await relay.disconnect();
        } finally {
            if (relay && relay.socket.connected) {
                await relay.disconnect().catch(() => {});
            }
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("emit conversation events through relay", async () => {
        const server = await createTestServer();
        let relay;
        try {
            relay = await createMockRelay(server);
            const session = await relay.registerSession();

            const conversation = buildConversation([
                { role: "user", text: "Hello" },
                { role: "assistant", text: "Hi there!" },
            ]);

            // Filter out harness:* marker events (e.g. harness:user_turn) before
            // emitting to the relay — they are not real protocol events and the
            // relay namespace will reject or ignore unknown types.
            const protocolEvents = conversation.filter(
                (e) => !(e as { type?: string }).type?.startsWith("harness:"),
            );
            for (let i = 0; i < protocolEvents.length; i++) {
                relay.emitEvent(session.sessionId, session.token, protocolEvents[i], i + 1);
            }

            // Give server time to process
            await Bun.sleep(100);

            await relay.disconnect();
        } finally {
            if (relay && relay.socket.connected) {
                await relay.disconnect().catch(() => {});
            }
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("waitForEvent times out on unknown event", async () => {
        const server = await createTestServer();
        let relay;
        try {
            relay = await createMockRelay(server);

            let threw = false;
            try {
                await relay.waitForEvent("nonexistent_event_xyz", 200);
            } catch (err) {
                threw = true;
                expect((err as Error).message).toContain("nonexistent_event_xyz");
            }
            expect(threw).toBe(true);

            await relay.disconnect();
        } finally {
            if (relay && relay.socket.connected) {
                await relay.disconnect().catch(() => {});
            }
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);
});
