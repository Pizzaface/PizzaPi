import { describe, test, expect } from "bun:test";
import { createSubagentMirror, resolveSocketIoUrl, readMirrorEnv, type MirrorEnv } from "./relay-mirror.js";
import type { SingleResult } from "./types.js";

// ── Fake socket ───────────────────────────────────────────────────────────────

interface Emitted {
    event: string;
    payload: any;
}

function makeFakeSocket() {
    const handlers = new Map<string, (arg?: any) => void>();
    const emitted: Emitted[] = [];
    let disconnected = false;
    return {
        emitted,
        get disconnected() {
            return disconnected;
        },
        fire(event: string, arg?: any) {
            handlers.get(event)?.(arg);
        },
        socket: {
            on(event: string, cb: (arg?: any) => void) {
                handlers.set(event, cb);
            },
            emit(event: string, payload: any) {
                emitted.push({ event, payload });
            },
            disconnect() {
                disconnected = true;
            },
            removeAllListeners() {
                handlers.clear();
            },
        },
    };
}

const ENV: MirrorEnv = {
    apiKey: "key-123",
    relayUrl: "wss://relay.example",
    parentSessionId: "parent-session",
};

function result(overrides: Partial<SingleResult> = {}): SingleResult {
    return {
        agent: "researcher",
        agentSource: "user",
        task: "look into the thing",
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        ...overrides,
    } as SingleResult;
}

// ── URL resolution ────────────────────────────────────────────────────────────

describe("resolveSocketIoUrl", () => {
    test("converts ws/wss to http/https and strips trailing slash", () => {
        expect(resolveSocketIoUrl({ relayUrl: "wss://relay.example/" })).toBe("https://relay.example");
        expect(resolveSocketIoUrl({ relayUrl: "ws://localhost:4000" })).toBe("http://localhost:4000");
    });

    test("explicit socket.io url wins", () => {
        expect(resolveSocketIoUrl({ relayUrl: "wss://a", socketIoUrl: "https://b/" })).toBe("https://b");
    });

    test("returns null when unset or disabled", () => {
        expect(resolveSocketIoUrl({})).toBeNull();
        expect(resolveSocketIoUrl({ relayUrl: "off" })).toBeNull();
        expect(resolveSocketIoUrl({ relayUrl: "OFF" })).toBeNull();
    });
});

describe("readMirrorEnv", () => {
    test("reads relay settings from the environment", () => {
        const env = readMirrorEnv({
            PIZZAPI_API_KEY: "k",
            PIZZAPI_RELAY_URL: "wss://r",
            PIZZAPI_SESSION_ID: "s",
        } as unknown as NodeJS.ProcessEnv);
        expect(env).toEqual({ apiKey: "k", relayUrl: "wss://r", socketIoUrl: undefined, parentSessionId: "s" });
    });
});

// ── Mirror lifecycle ──────────────────────────────────────────────────────────

describe("createSubagentMirror", () => {
    test("returns null when the relay is not configured", () => {
        expect(createSubagentMirror({ agentName: "a", task: "t", cwd: "/tmp", env: {} })).toBeNull();
        expect(
            createSubagentMirror({ agentName: "a", task: "t", cwd: "/tmp", env: { ...ENV, apiKey: undefined } }),
        ).toBeNull();
        expect(
            createSubagentMirror({ agentName: "a", task: "t", cwd: "/tmp", env: { ...ENV, parentSessionId: undefined } }),
        ).toBeNull();
        expect(
            createSubagentMirror({ agentName: "a", task: "t", cwd: "/tmp", env: { ...ENV, relayUrl: "off" } }),
        ).toBeNull();
    });

    test("registers as a child session with parentSessionId on connect", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "researcher",
            task: "look into the thing",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        expect(mirror).not.toBeNull();

        fake.fire("connect");
        const register = fake.emitted.find((e) => e.event === "register");
        expect(register).toBeDefined();
        expect(register!.payload.parentSessionId).toBe("parent-session");
        expect(register!.payload.sessionId).toBe(mirror.sessionId);
        expect(register!.payload.ephemeral).toBe(true);
        expect(register!.payload.cwd).toBe("/repo");
        expect(register!.payload.sessionName).toBe("researcher: look into the thing");
    });

    test("buffers updates until registered, then emits a snapshot", () => {
        const fake = makeFakeSocket();
        let clock = 1000;
        const mirror = createSubagentMirror({
            agentName: "researcher",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
            now: () => clock,
        })!;

        fake.fire("connect");
        mirror.update(result({ messages: [{ role: "assistant" } as any] }));
        // No token yet — nothing forwarded.
        expect(fake.emitted.some((e) => e.event === "event")).toBe(false);

        fake.fire("registered", { token: "tok" });
        const events = fake.emitted.filter((e) => e.event === "event");
        expect(events.map((e) => e.payload.event.type)).toEqual([
            "session_active",
            "heartbeat",
            "token_usage_updated",
        ]);
        expect(events[0].payload.token).toBe("tok");
        expect(events[0].payload.event.state.messages.length).toBe(1);
        expect(events[1].payload.event).toMatchObject({ type: "heartbeat", active: true });
    });

    test("throttles snapshots within the window", () => {
        const fake = makeFakeSocket();
        let clock = 1000;
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
            now: () => clock,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.update(result());
        const afterFirst = fake.emitted.filter((e) => e.event === "event").length;
        mirror.update(result());
        expect(fake.emitted.filter((e) => e.event === "event").length).toBe(afterFirst);

        // Past SNAPSHOT_THROTTLE_MS (10s).
        clock += 11_000;
        mirror.update(result());
        expect(fake.emitted.filter((e) => e.event === "event").length).toBeGreaterThan(afterFirst);
    });

    test("forwards live agent events verbatim, drops unstreamed ones", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;

        // Before registration nothing is forwarded (the snapshot flush covers it).
        mirror.forward({ type: "message_update" } as any);
        expect(fake.emitted.some((e) => e.event === "event")).toBe(false);

        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.forward({ type: "message_update", message: { role: "assistant" } } as any);
        mirror.forward({ type: "tool_execution_start", toolName: "read" } as any);
        // agent_end carries run-scoped messages the UI treats as a full snapshot.
        mirror.forward({ type: "agent_end", messages: [] } as any);

        const types = fake.emitted
            .filter((e) => e.event === "event")
            .map((e) => e.payload.event.type);
        expect(types).toContain("message_update");
        expect(types).toContain("tool_execution_start");
        expect(types).not.toContain("agent_end");

        mirror.finish(result());
        const count = fake.emitted.length;
        mirror.forward({ type: "message_update" } as any);
        expect(fake.emitted.length).toBe(count);
    });

    test("setModel emits a real provider/model chip and sticks in snapshots", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.setModel({ provider: "claude-subscription", id: "claude-haiku-4-5", name: "Haiku" });
        mirror.finish(result({ usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5, contextTokens: 99, turns: 1 } }));

        const events = fake.emitted.filter((e) => e.event === "event").map((e) => e.payload.event);
        expect(events.find((e) => e.type === "model_changed").model.provider).toBe("claude-subscription");
        expect(events.find((e) => e.type === "session_active").state.model.id).toBe("claude-haiku-4-5");
        expect(events.find((e) => e.type === "token_usage_updated").tokenUsage).toMatchObject({
            input: 10,
            cost: 0.5,
            contextTokens: 99,
        });
    });

    test("finish emits a final snapshot, ends the session, and disconnects", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.finish(result({ exitCode: 0, model: "claude-haiku-4-5" }));

        const heartbeats = fake.emitted.filter((e) => e.event === "event" && e.payload.event.type === "heartbeat");
        expect(heartbeats.at(-1)!.payload.event.active).toBe(false);
        expect(fake.emitted.some((e) => e.event === "session_end")).toBe(true);
        expect(fake.disconnected).toBe(true);

        // Post-finish calls are inert.
        const count = fake.emitted.length;
        mirror.update(result());
        mirror.finish(result());
        expect(fake.emitted.length).toBe(count);
    });

    test("setModel emits a provider/model chip that sticks in later snapshots", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.setModel({ provider: "claude-subscription", id: "claude-haiku-4-5", name: "Haiku" });
        mirror.finish(result({ model: "ignored-bare-id" }));

        const events = fake.emitted.filter((e) => e.event === "event").map((e) => e.payload.event);
        expect(events.find((e) => e.type === "model_changed").model).toMatchObject({
            provider: "claude-subscription",
            id: "claude-haiku-4-5",
        });
        // The resolved model wins over the bare id from assistant messages.
        expect(events.find((e) => e.type === "session_active").state.model).toMatchObject({
            provider: "claude-subscription",
            id: "claude-haiku-4-5",
        });
    });

    test("falls back to the bare assistant model id when none was resolved", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });
        mirror.finish(result({ model: "claude-haiku-4-5" }));

        const active = fake.emitted.find(
            (e) => e.event === "event" && e.payload.event.type === "session_active",
        )!;
        expect(active.payload.event.state.model).toMatchObject({ provider: "", id: "claude-haiku-4-5" });
    });

    test("snapshots carry token usage for the UI usage bar", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        mirror.finish(
            result({
                usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5, contextTokens: 99, turns: 1 },
            }),
        );

        const usage = fake.emitted.find(
            (e) => e.event === "event" && e.payload.event.type === "token_usage_updated",
        )!;
        expect(usage.payload.event.tokenUsage).toMatchObject({
            input: 10,
            output: 5,
            cost: 0.5,
            contextTokens: 99,
        });
    });

    test("caps the mirrored transcript", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok" });

        const messages = Array.from({ length: 500 }, (_, i) => ({ role: "assistant", i })) as any[];
        mirror.finish(result({ messages }));

        const active = fake.emitted.find((e) => e.event === "event" && e.payload.event.type === "session_active")!;
        expect(active.payload.event.state.messages.length).toBe(200);
        expect(active.payload.event.state.messages[0].i).toBe(300);
    });

    test("truncates long tasks in the session name and labels chain steps", () => {
        const fake = makeFakeSocket();
        createSubagentMirror({
            agentName: "coder",
            task: "x".repeat(100),
            cwd: "/repo",
            step: 2,
            env: ENV,
            socketFactory: () => fake.socket,
        })!;
        fake.fire("connect");
        const name = fake.emitted.find((e) => e.event === "register")!.payload.sessionName as string;
        expect(name.startsWith("coder #3: ")).toBe(true);
        expect(name.endsWith("…")).toBe(true);
    });
});

// ── Reconnect behavior ────────────────────────────────────────────────────────

describe("subagent mirror reconnect", () => {
    test("re-registers the same sessionId after a relay blip and replays the last snapshot", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
            now: (() => { let t = 0; return () => (t += 20000); })(),
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok-1" });
        mirror.update(result({ messages: [{ role: "assistant", content: "hi" }] as any }));
        const firstSessionId = fake.emitted.find((e) => e.event === "register")!.payload.sessionId;

        // Relay blip
        fake.fire("disconnect");
        const countBefore = fake.emitted.length;
        // Emits while disconnected are suppressed (token invalidated)
        mirror.update(result());
        expect(fake.emitted.length).toBe(countBefore);

        // Reconnect: register re-sent with the SAME session id
        fake.fire("connect");
        const registers = fake.emitted.filter((e) => e.event === "register");
        expect(registers.length).toBe(2);
        expect(registers[1].payload.sessionId).toBe(firstSessionId);
        expect(registers[1].payload.parentSessionId).toBe("parent-session");

        // New token accepted; pending/last snapshot flushed under it
        fake.fire("registered", { token: "tok-2" });
        const events = fake.emitted.filter((e) => e.event === "event");
        const last = events[events.length - 1];
        expect(last.payload.token).toBe("tok-2");
    });

    test("replays last snapshot on re-register even with no pending update", () => {
        const fake = makeFakeSocket();
        const mirror = createSubagentMirror({
            agentName: "a",
            task: "t",
            cwd: "/repo",
            env: ENV,
            socketFactory: () => fake.socket,
            now: (() => { let t = 0; return () => (t += 20000); })(),
        })!;
        fake.fire("connect");
        fake.fire("registered", { token: "tok-1" });
        mirror.update(result({ messages: [{ role: "assistant", content: "hi" }] as any }));
        const eventsBefore = fake.emitted.filter((e) => e.event === "event").length;
        expect(eventsBefore).toBeGreaterThan(0);

        fake.fire("disconnect");
        fake.fire("connect");
        fake.fire("registered", { token: "tok-2" });

        const active = fake.emitted
            .filter((e) => e.event === "event" && e.payload.event.type === "session_active")
            .pop()!;
        expect(active.payload.token).toBe("tok-2");
        expect(active.payload.event.state.messages.length).toBe(1);
    });
});
