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
        expect(events.length).toBe(2); // session_active + heartbeat
        expect(events[0].payload.token).toBe("tok");
        expect(events[0].payload.event.type).toBe("session_active");
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

        clock += 2000;
        mirror.update(result());
        expect(fake.emitted.filter((e) => e.event === "event").length).toBeGreaterThan(afterFirst);
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
