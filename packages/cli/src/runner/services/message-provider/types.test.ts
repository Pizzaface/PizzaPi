import { describe, test, expect } from "bun:test";
import {
    ChannelRouter,
    ProviderRegistry,
    EventForwarder,
    validateProviderConfig,
    isSessionEventType,
    type Channel,
    type ChannelRouterConfig,
    type ChannelSession,
    type InboundMessage,
    type MessageProvider,
    type OutboundMessage,
    type ProviderConfig,
    type SessionEvent,
} from "./index.js";

class MockProvider implements MessageProvider {
    readonly id: string;
    readonly label: string;
    connected = false;
    readonly handlers: Array<(message: InboundMessage) => void | Promise<void>> = [];
    channels: Channel[] = [];
    lastSent: { channelId: string; message: OutboundMessage } | undefined;
    failNextConnect = false;

    constructor(id: string, label = id) {
        this.id = id;
        this.label = label;
    }

    async connect(_config: ProviderConfig): Promise<void> {
        if (this.failNextConnect) {
            this.failNextConnect = false;
            throw new Error("connect failed");
        }
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async send(channelId: string, message: OutboundMessage): Promise<void> {
        this.lastSent = { channelId, message };
    }

    async listChannels(): Promise<Channel[]> {
        return this.channels;
    }

    onMessage(handler: (message: InboundMessage) => void | Promise<void>): void {
        this.handlers.push(handler);
    }

    offMessage(handler: (message: InboundMessage) => void | Promise<void>): void {
        const index = this.handlers.indexOf(handler);
        if (index >= 0) {
            this.handlers.splice(index, 1);
        }
    }

    emit(message: InboundMessage): void {
        for (const handler of this.handlers) {
            void handler(message);
        }
    }
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
        id: "msg-1",
        channelId: "ch-1",
        channelName: "general",
        author: { id: "u-1", username: "tester", displayName: "Tester" },
        content: "hello",
        timestamp: Date.now(),
        isCommand: false,
        raw: {},
        ...overrides,
    };
}

describe("validateProviderConfig", () => {
    test("accepts a minimal valid config", () => {
        const result = validateProviderConfig({ token: "abc" });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    test("rejects missing token", () => {
        const result = validateProviderConfig({});
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("token must be a non-empty string");
    });

    test("rejects non-string token", () => {
        const result = validateProviderConfig({ token: 123 });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("token must be a non-empty string");
    });

    test("validates allowedChannels", () => {
        const good = validateProviderConfig({ token: "abc", allowedChannels: ["c1", "c2"] });
        expect(good.valid).toBe(true);

        const bad = validateProviderConfig({ token: "abc", allowedChannels: [1, 2] });
        expect(bad.valid).toBe(false);
        expect(bad.errors).toContain("allowedChannels must be an array of strings");
    });

    test("validates channelRouters", () => {
        const good = validateProviderConfig({
            token: "abc",
            channelRouters: {
                c1: { mode: "commands-only" },
                c2: { mode: "all-messages" },
                c3: { mode: "filtered", filterPatterns: ["alert"] },
            },
        });
        expect(good.valid).toBe(true);

        const bad = validateProviderConfig({
            token: "abc",
            channelRouters: {
                c1: { mode: "invalid" } as unknown as ChannelRouterConfig,
            },
        });
        expect(bad.valid).toBe(false);
        expect(bad.errors).toContain('channelRouters["c1"] is invalid');
    });

    test("validates defaultRouter", () => {
        const good = validateProviderConfig({ token: "abc", defaultRouter: { mode: "commands-only" } });
        expect(good.valid).toBe(true);

        const bad = validateProviderConfig({
            token: "abc",
            defaultRouter: { mode: "all-messages", commandPrefix: "" } as ChannelRouterConfig,
        });
        expect(bad.valid).toBe(false);
        expect(bad.errors).toContain("defaultRouter is invalid");
    });

    test("validates forwardEvents", () => {
        const good = validateProviderConfig({ token: "abc", forwardEvents: ["session.start", "build.success"] });
        expect(good.valid).toBe(true);

        const bad = validateProviderConfig({ token: "abc", forwardEvents: ["session.start", "nope"] });
        expect(bad.valid).toBe(false);
        expect(bad.errors).toContain("forwardEvents must be an array of valid SessionEventType values");
    });

    test("validates options", () => {
        const good = validateProviderConfig({ token: "abc", options: { foo: "bar" } });
        expect(good.valid).toBe(true);

        const bad = validateProviderConfig({ token: "abc", options: "nope" });
        expect(bad.valid).toBe(false);
        expect(bad.errors).toContain("options must be an object");
    });

    test("isSessionEventType guards correctly", () => {
        expect(isSessionEventType("session.start")).toBe(true);
        expect(isSessionEventType("nope")).toBe(false);
        expect(isSessionEventType(123)).toBe(false);
    });
});

describe("ChannelRouter", () => {
    test("parses command prefix and extracts name and args", () => {
        const router = new ChannelRouter();
        const message = makeMessage({ content: "!help arg1 arg2" });
        const parsed = router.parseMessage(message, { mode: "commands-only" });

        expect(parsed.isCommand).toBe(true);
        expect(parsed.command).toEqual({ name: "help", args: ["arg1", "arg2"], raw: "help arg1 arg2" });
    });

    test("does not treat plain messages as commands", () => {
        const router = new ChannelRouter();
        const message = makeMessage({ content: "hello world" });
        const parsed = router.parseMessage(message, { mode: "commands-only" });

        expect(parsed.isCommand).toBe(false);
        expect(parsed.command).toBeUndefined();
    });

    test("uses custom command prefix", () => {
        const router = new ChannelRouter();
        const message = makeMessage({ content: "/ping" });
        const parsed = router.parseMessage(message, { mode: "commands-only", commandPrefix: "/" });

        expect(parsed.isCommand).toBe(true);
        expect(parsed.command?.name).toBe("ping");
    });

    test("ignores empty commands", () => {
        const router = new ChannelRouter();
        const message = makeMessage({ content: "!" });
        const parsed = router.parseMessage(message, { mode: "commands-only" });

        expect(parsed.isCommand).toBe(false);
    });

    test("truncates long messages", () => {
        const router = new ChannelRouter();
        const content = "a".repeat(100);
        const message = makeMessage({ content });
        const parsed = router.parseMessage(message, { mode: "all-messages", maxMessageLength: 10 });

        expect(parsed.content).toBe("a".repeat(10));
    });

    test("routes to mapped session", () => {
        const router = new ChannelRouter();
        const session: ChannelSession = {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        };
        router.addSession(session);

        const route = router.route(makeMessage({ content: "!status" }));
        expect(route).toBeDefined();
        expect(route!.sessionId).toBe("sess-1");
        expect(route!.shouldForward).toBe(true);
    });

    test("does not route unmapped channels", () => {
        const router = new ChannelRouter();
        const route = router.route(makeMessage({ channelId: "unknown" }));
        expect(route).toBeUndefined();
    });

    test("all-messages mode forwards everything", () => {
        const router = new ChannelRouter();
        router.addSession({ channelId: "ch-1", sessionId: "sess-1", config: { mode: "all-messages" } });

        const route = router.route(makeMessage({ content: "hello" }));
        expect(route!.shouldForward).toBe(true);
        expect(route!.message.isCommand).toBe(false);
    });

    test("filtered mode matches patterns", () => {
        const router = new ChannelRouter();
        router.addSession({
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "filtered", filterPatterns: ["alert", "warn"] },
        });

        expect(router.route(makeMessage({ content: "this is an alert" }))!.shouldForward).toBe(true);
        expect(router.route(makeMessage({ content: "normal chat" }))!.shouldForward).toBe(false);
    });

    test("finds channels by session id", () => {
        const router = new ChannelRouter();
        router.addSession({ channelId: "ch-1", sessionId: "sess-a", config: { mode: "commands-only" } });
        router.addSession({ channelId: "ch-2", sessionId: "sess-a", config: { mode: "commands-only" } });
        router.addSession({ channelId: "ch-3", sessionId: "sess-b", config: { mode: "commands-only" } });

        const found = router.findChannelsBySessionId("sess-a");
        expect(found.map((s) => s.channelId).sort()).toEqual(["ch-1", "ch-2"]);
    });

    test("removeSession drops the mapping", () => {
        const router = new ChannelRouter();
        router.addSession({ channelId: "ch-1", sessionId: "sess-1", config: { mode: "commands-only" } });
        router.removeSession("ch-1");
        expect(router.route(makeMessage())).toBeUndefined();
    });
});

describe("ProviderRegistry", () => {
    test("register and get provider", () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc" });

        expect(registry.getProvider("mock")).toBe(provider);
        expect(registry.getConfig("mock")?.token).toBe("abc");
    });

    test("throws on duplicate provider id", () => {
        const registry = new ProviderRegistry();
        registry.register(new MockProvider("mock"), { token: "abc" });
        expect(() => registry.register(new MockProvider("mock"), { token: "def" })).toThrow(
            'ProviderRegistry: duplicate provider id "mock"',
        );
    });

    test("connect and disconnect", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc" });

        await registry.connect("mock");
        expect(provider.isConnected()).toBe(true);

        await registry.disconnect("mock");
        expect(provider.isConnected()).toBe(false);
    });

    test("throws when connecting unknown provider", async () => {
        const registry = new ProviderRegistry();
        expect(registry.connect("missing")).rejects.toThrow('ProviderRegistry: unknown provider "missing"');
    });

    test("throws when connecting provider without config", async () => {
        const registry = new ProviderRegistry();
        registry.register(new MockProvider("mock"));
        expect(registry.connect("mock")).rejects.toThrow('ProviderRegistry: no config for provider "mock"');
    });

    test("records lastError on connect failure", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        provider.failNextConnect = true;
        registry.register(provider, { token: "abc" });

        await expect(registry.connect("mock")).rejects.toThrow("connect failed");
        const status = registry.getStatus()[0];
        expect(status.lastError).toBe("connect failed");
    });

    test("unregister disconnects and removes provider", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc" });
        await registry.connect("mock");

        await registry.unregister("mock");
        expect(registry.getProvider("mock")).toBeUndefined();
        expect(provider.isConnected()).toBe(false);
    });

    test("status reflects connected state, metrics, and mapped sessions", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        provider.channels = [{ id: "ch-1", name: "general", type: "text" }];
        registry.register(provider, { token: "abc" });
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        let status = registry.getStatus()[0];
        expect(status.connected).toBe(false);
        expect(status.sessionsMapped).toBe(1);

        await registry.connect("mock");
        status = registry.getStatus()[0];
        expect(status.connected).toBe(true);
        expect(status.channelCount).toBe(1);
    });

    test("inbound messages increment messagesIn and route to handlers", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, {
            token: "abc",
            channelRouters: { "ch-1": { mode: "commands-only" } },
        });
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const received: Array<{ message: InboundMessage; route: { sessionId: string } }> = [];
        registry.onRoutedMessage((message, route) => {
            received.push({ message, route });
        });

        provider.emit(makeMessage({ content: "!status" }));
        provider.emit(makeMessage({ content: "not a command" }));

        expect(received).toHaveLength(1);
        expect(received[0].message.command?.name).toBe("status");
        expect(received[0].route.sessionId).toBe("sess-1");

        const status = registry.getStatus()[0];
        expect(status.messagesIn).toBe(2);
    });

    test("send increments messagesOut", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc" });
        await registry.connect("mock");

        await registry.send("mock", "ch-1", { content: "hi" });
        expect(provider.lastSent?.channelId).toBe("ch-1");
        expect(registry.getStatus()[0].messagesOut).toBe(1);
    });

    test("allowedChannels filters inbound messages", () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, {
            token: "abc",
            allowedChannels: ["ch-1"],
            channelRouters: { "ch-1": { mode: "all-messages" }, "ch-2": { mode: "all-messages" } },
        });
        registry.addChannelSession("mock", { channelId: "ch-1", sessionId: "s1", config: { mode: "all-messages" } });
        registry.addChannelSession("mock", { channelId: "ch-2", sessionId: "s2", config: { mode: "all-messages" } });

        const received: InboundMessage[] = [];
        registry.onRoutedMessage((message) => {
            received.push(message);
        });

        provider.emit(makeMessage({ channelId: "ch-1", content: "hello" }));
        provider.emit(makeMessage({ channelId: "ch-2", content: "hello" }));

        expect(received).toHaveLength(1);
        expect(received[0].channelId).toBe("ch-1");
    });

    test("connectAll connects all configured providers", async () => {
        const registry = new ProviderRegistry();
        const a = new MockProvider("a");
        const b = new MockProvider("b");
        registry.register(a, { token: "a" });
        registry.register(b); // no config

        await registry.connectAll();
        expect(a.isConnected()).toBe(true);
        expect(b.isConnected()).toBe(false);
    });
});

describe("EventForwarder", () => {
    test("formats session events with default templates", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc", forwardEvents: ["session.start"] });
        await registry.connect("mock");
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const forwarder = new EventForwarder(registry);
        await forwarder.forward({ type: "session.start", sessionId: "sess-1" });

        expect(provider.lastSent?.channelId).toBe("ch-1");
        expect(provider.lastSent?.message.content).toBe("Session sess-1 started");
    });

    test("renders custom templates and payload placeholders", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, {
            token: "abc",
            forwardEvents: ["build.failure"],
        });
        await registry.connect("mock");
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const forwarder = new EventForwarder(registry, {
            "build.failure": "🔥 {{sessionId}}: {{message}}",
        });
        await forwarder.forward({
            type: "build.failure",
            sessionId: "sess-1",
            payload: { message: "tests failed" },
        });

        expect(provider.lastSent?.message.content).toBe("🔥 sess-1: tests failed");
    });

    test("does not forward to providers not subscribed to event", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc", forwardEvents: ["session.complete"] });
        await registry.connect("mock");
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const forwarder = new EventForwarder(registry);
        await forwarder.forward({ type: "session.start", sessionId: "sess-1" });

        expect(provider.lastSent).toBeUndefined();
    });

    test("does not forward to disconnected providers", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc", forwardEvents: ["session.start"] });
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });
        // intentionally not connected

        const forwarder = new EventForwarder(registry);
        await forwarder.forward({ type: "session.start", sessionId: "sess-1" });

        expect(provider.lastSent).toBeUndefined();
    });

    test("does not forward when no channel is mapped to the session", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc", forwardEvents: ["session.start"] });
        await registry.connect("mock");
        // no channel mapping

        const forwarder = new EventForwarder(registry);
        await forwarder.forward({ type: "session.start", sessionId: "sess-1" });

        expect(provider.lastSent).toBeUndefined();
    });

    test("forwards to multiple channels mapped to the same session", async () => {
        const registry = new ProviderRegistry();
        const provider = new MockProvider("mock");
        registry.register(provider, { token: "abc", forwardEvents: ["session.start"] });
        await registry.connect("mock");
        registry.addChannelSession("mock", {
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });
        registry.addChannelSession("mock", {
            channelId: "ch-2",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const forwarder = new EventForwarder(registry);
        await forwarder.forward({ type: "session.start", sessionId: "sess-1" });

        expect(provider.lastSent?.channelId).toBe("ch-2");
    });

    test("setTemplate updates a single template", () => {
        const registry = new ProviderRegistry();
        const forwarder = new EventForwarder(registry);
        forwarder.setTemplate("review.lgtm", "✅ {{sessionId}}");
        expect(forwarder.getTemplates()["review.lgtm"]).toBe("✅ {{sessionId}}");
    });
});
