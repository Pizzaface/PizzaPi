import { describe, test, expect, beforeEach } from "bun:test";
import { createDiscordMirrorExtension, lastAssistantText, sanitizeToolInput } from "./discord-mirror.js";

function createMockPi() {
    const handlers = new Map<string, Function[]>();
    return {
        on(event: string, handler: Function) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event)!.push(handler);
        },
        fire(event: string, payload?: unknown) {
            for (const h of handlers.get(event) ?? []) h(payload, {});
        },
        registerTool: () => {},
        registerCommand: () => {},
    };
}

function assistantMsg(...texts: string[]) {
    return { role: "assistant", content: texts.map((text) => ({ type: "text", text })) };
}

describe("lastAssistantText", () => {
    test("returns null for non-arrays and empty runs", () => {
        expect(lastAssistantText(undefined)).toBeNull();
        expect(lastAssistantText(null)).toBeNull();
        expect(lastAssistantText([])).toBeNull();
        expect(lastAssistantText("nope")).toBeNull();
    });

    test("picks the last assistant message, joining text parts", () => {
        const messages = [
            assistantMsg("first"),
            { role: "user", content: [{ type: "text", text: "middle" }] },
            assistantMsg("a", "b"),
        ];
        expect(lastAssistantText(messages)).toBe("a\nb");
    });

    test("skips assistant messages with no text parts (tool-only turns)", () => {
        const messages = [
            assistantMsg("real answer"),
            { role: "assistant", content: [{ type: "tool_use", id: "1", name: "bash" }] },
        ];
        expect(lastAssistantText(messages)).toBe("real answer");
    });

    test("ignores malformed content entries", () => {
        const messages = [{ role: "assistant", content: [null, 42, { type: "text" }, { type: "text", text: "ok" }] }];
        expect(lastAssistantText(messages)).toBe("ok");
    });

    test("returns null when the assistant only produced whitespace", () => {
        expect(lastAssistantText([assistantMsg("   \n  ")])).toBeNull();
    });

    test("truncates very long output", () => {
        const result = lastAssistantText([assistantMsg("x".repeat(9_000))])!;
        expect(result.length).toBeLessThan(9_000);
        expect(result.endsWith("…(truncated)")).toBe(true);
    });
});

describe("discordMirrorExtension", () => {
    let emitted: any[];
    let pi: ReturnType<typeof createMockPi>;

    function build(opts: { socket?: boolean; sessionId?: string | null; throwOnEmit?: boolean } = {}) {
        emitted = [];
        pi = createMockPi();
        let n = 0;
        const socket = {
            emit: (event: string, payload: unknown) => {
                if (opts.throwOnEmit) throw new Error("socket closed");
                emitted.push({ event, payload });
            },
        };
        createDiscordMirrorExtension({
            getRelaySocket: (() => (opts.socket === false ? null : { socket })) as any,
            getRelaySessionId: (() => (opts.sessionId === undefined ? "sess-1" : opts.sessionId)) as any,
            newId: () => `id-${++n}`,
        })(pi as any);
    }

    beforeEach(() => build());

    test("emits one discord_post envelope per settled turn", () => {
        pi.fire("agent_end", { messages: [assistantMsg("hello world")] });
        pi.fire("agent_settled");

        expect(emitted).toHaveLength(1);
        expect(emitted[0].event).toBe("service_message");
        expect(emitted[0].payload).toEqual({
            serviceId: "discord",
            type: "discord_post",
            payload: { id: "id-1", sessionId: "sess-1", content: "hello world" },
        });
    });

    // Relay delivery to the runner is at-least-once (emitToRunner hits both the
    // runner room and the local socket), so the service dedupes on this id.
    // A repeated id across turns would silently swallow a real message.
    test("stamps a distinct id on every envelope", () => {
        pi.fire("agent_end", { messages: [assistantMsg("one")] });
        pi.fire("agent_settled");
        pi.fire("agent_end", { messages: [assistantMsg("two")] });
        pi.fire("agent_settled");

        const ids = emitted.map((e) => e.payload.payload.id);
        expect(ids).toEqual(["id-1", "id-2"]);
        expect(new Set(ids).size).toBe(2);
    });

    test("does not emit on agent_end alone — only after settling", () => {
        pi.fire("agent_end", { messages: [assistantMsg("draft")] });
        expect(emitted).toHaveLength(0);
    });

    test("mirrors only the final attempt when a turn is retried", () => {
        pi.fire("agent_end", { messages: [assistantMsg("attempt one")] });
        pi.fire("agent_end", { messages: [assistantMsg("attempt two")] });
        pi.fire("agent_settled");

        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.payload.content).toBe("attempt two");
    });

    test("does not re-emit the previous turn when a later turn has no text", () => {
        pi.fire("agent_end", { messages: [assistantMsg("turn one")] });
        pi.fire("agent_settled");
        pi.fire("agent_end", { messages: [] });
        pi.fire("agent_settled");

        expect(emitted).toHaveLength(1);
    });

    test("no-ops without a relay socket", () => {
        build({ socket: false });
        pi.fire("agent_end", { messages: [assistantMsg("hi")] });
        pi.fire("agent_settled");
        expect(emitted).toHaveLength(0);
    });

    test("no-ops without a relay session id", () => {
        build({ sessionId: null });
        pi.fire("agent_end", { messages: [assistantMsg("hi")] });
        pi.fire("agent_settled");
        expect(emitted).toHaveLength(0);
    });

    test("a throwing socket does not break the turn", () => {
        build({ throwOnEmit: true });
        pi.fire("agent_end", { messages: [assistantMsg("hi")] });
        expect(() => pi.fire("agent_settled")).not.toThrow();
    });

    test("mirrors mid-turn assistant text as a discord_activity line, not just the final post", () => {
        pi.fire("message_end", { message: assistantMsg("let me check that file first") });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_activity");
        expect(emitted[0].payload.payload.line).toBe("\u{1F4AC} let me check that file first");
    });

    test("ignores message_end for non-assistant or textless messages", () => {
        pi.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } });
        pi.fire("message_end", { message: { role: "assistant", content: [{ type: "tool_use", id: "1", name: "bash" }] } });
        expect(emitted).toHaveLength(0);
    });

    test("truncates long mid-turn assistant text for the activity preview", () => {
        pi.fire("message_end", { message: assistantMsg("x".repeat(500)) });
        const line = emitted[0].payload.payload.line as string;
        expect(line.length).toBeLessThan(320);
        expect(line.endsWith("\u2026")).toBe(true);
    });

    test("emits a discord_activity envelope with raw toolName/input for each tool call", () => {
        pi.fire("tool_call", { toolName: "bash", input: { command: "ls -la" } });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_activity");
        expect(emitted[0].payload.payload).toMatchObject({
            sessionId: "sess-1",
            toolName: "bash",
            input: { command: "ls -la" },
        });
    });

    test("forwards update_todo's input as-is — no per-tool hardcoding needed", () => {
        const todos = [{ id: 1, text: "Do the thing", status: "in_progress" }];
        pi.fire("tool_call", { toolName: "update_todo", input: { todos } });
        expect(emitted[0].payload.payload).toMatchObject({ toolName: "update_todo", input: { todos } });
    });

    test("defers edit's activity line to tool_result so it can carry +/- diff stats", () => {
        pi.fire("tool_call", { toolName: "edit", input: { path: "src/x.ts", edits: [] } });
        expect(emitted).toHaveLength(0);

        pi.fire("tool_result", {
            toolName: "edit",
            isError: false,
            input: { path: "src/x.ts" },
            details: { patch: "--- a/x.ts\n+++ b/x.ts\n@@\n-old line\n-old line 2\n+new line\n+new line 2\n+new line 3\n" },
        });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.payload).toMatchObject({
            toolName: "edit",
            input: { path: "src/x.ts", added: 3, removed: 2 },
        });
    });

    test("falls back to plain path when edit has no parsable patch", () => {
        pi.fire("tool_result", { toolName: "edit", isError: false, input: { path: "src/x.ts" }, details: undefined });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.payload.input).toEqual({ path: "src/x.ts" });
    });

    test("tags write's activity line with an added-lines count (no removed — no \"before\" to diff)", () => {
        pi.fire("tool_call", { toolName: "write", input: { path: "src/new.ts", content: "a\nb\nc" } });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.payload).toMatchObject({
            toolName: "write",
            input: { path: "src/new.ts", added: 3 },
        });
        expect(emitted[0].payload.payload.input.removed).toBeUndefined();
    });

    test("omits the added count for an empty write", () => {
        pi.fire("tool_call", { toolName: "write", input: { path: "src/empty.ts", content: "" } });
        expect(emitted[0].payload.payload.input.added).toBeUndefined();
    });

    test("surfaces tool errors but stays quiet on other successes", () => {
        pi.fire("tool_result", { toolName: "bash", isError: false });
        expect(emitted).toHaveLength(0);
        pi.fire("tool_result", { toolName: "bash", isError: true });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.payload.line).toContain("failed");
    });

    test("emits discord_ask_resolved when AskUserQuestion finishes, so Discord closes its poll", () => {
        pi.fire("tool_result", { toolName: "AskUserQuestion", toolCallId: "tc-9", isError: false });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_ask_resolved");
        expect(emitted[0].payload.payload).toMatchObject({ sessionId: "sess-1", toolCallId: "tc-9" });
    });

    test("does not emit discord_ask_resolved when AskUserQuestion errors", () => {
        pi.fire("tool_result", { toolName: "AskUserQuestion", toolCallId: "tc-9", isError: true });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_activity");
    });

    test("routes AskUserQuestion to a discord_ask envelope, not activity", () => {
        pi.fire("tool_call", {
            toolCallId: "tc-1",
            toolName: "AskUserQuestion",
            input: { questions: [{ question: "Ship?", options: ["Yes", "No"], type: "radio" }] },
        });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_ask");
        expect(emitted[0].payload.payload.toolCallId).toBe("tc-1");
        expect(emitted[0].payload.payload.questions[0]).toMatchObject({ question: "Ship?", options: ["Yes", "No"], type: "radio" });
    });

    test("routes plan_mode to a discord_plan envelope with title and steps", () => {
        pi.fire("tool_call", {
            toolCallId: "tc-2",
            toolName: "plan_mode",
            input: { title: "My plan", description: "why", steps: [{ title: "one" }] },
        });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_plan");
        expect(emitted[0].payload.payload).toMatchObject({ toolCallId: "tc-2", title: "My plan", description: "why" });
        expect(emitted[0].payload.payload.steps).toEqual([{ title: "one" }]);
    });

    test("emits discord_rename when the session name changes", () => {
        pi.fire("session_info_changed", { name: "  Relay prompts through Discord  " });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].payload.type).toBe("discord_rename");
        expect(emitted[0].payload.payload.name).toBe("Relay prompts through Discord");
    });

    test("ignores a cleared session name", () => {
        pi.fire("session_info_changed", { name: "" });
        pi.fire("session_info_changed", {});
        expect(emitted).toHaveLength(0);
    });
});

describe("sanitizeToolInput", () => {
    test("passes small inputs through unchanged", () => {
        expect(sanitizeToolInput({ path: "src/x.ts" })).toEqual({ path: "src/x.ts" });
    });

    test("caps long string fields so huge file/bash content doesn't ship over the relay", () => {
        const big = "x".repeat(1_000);
        const out = sanitizeToolInput({ content: big });
        expect((out.content as string).length).toBeLessThan(1_000);
        expect((out.content as string).endsWith("…")).toBe(true);
    });

    test("leaves non-string fields (e.g. a todos array) alone", () => {
        const todos = [{ id: 1, text: "a", status: "pending" }];
        expect(sanitizeToolInput({ todos })).toEqual({ todos });
    });

    test("returns {} for non-object input", () => {
        expect(sanitizeToolInput(undefined)).toEqual({});
        expect(sanitizeToolInput(null)).toEqual({});
        expect(sanitizeToolInput("nope")).toEqual({});
    });
});
