import { describe, test, expect, beforeEach } from "bun:test";
import { createDiscordMirrorExtension, lastAssistantText } from "./discord-mirror.js";

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
        const socket = {
            emit: (event: string, payload: unknown) => {
                if (opts.throwOnEmit) throw new Error("socket closed");
                emitted.push({ event, payload });
            },
        };
        createDiscordMirrorExtension({
            getRelaySocket: (() => (opts.socket === false ? null : { socket })) as any,
            getRelaySessionId: (() => (opts.sessionId === undefined ? "sess-1" : opts.sessionId)) as any,
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
            payload: { sessionId: "sess-1", content: "hello world" },
        });
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
});
