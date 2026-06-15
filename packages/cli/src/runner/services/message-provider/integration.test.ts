/**
 * Integration tests for the message-provider subsystem.
 *
 * These tests exercise the real classes together (with network mocked) to
 * verify end-to-end routing, bridge wiring, config parsing, and manifest
 * structure.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { MessageBridgeService, type MessageBridgeConfig } from "./bridge-service.js";
import { ChannelRouter } from "./channel-router.js";
import { EventForwarder, type SessionEvent } from "./event-forwarder.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { Channel, InboundMessage, InboundMessageHandler, MessageProvider, OutboundMessage, ProviderConfig, ProviderStatus } from "./types.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalRelayUrl = process.env.PIZZAPI_RELAY_URL;
const originalApiKey = process.env.PIZZAPI_RUNNER_API_KEY;

let service: MessageBridgeService | null = null;

afterEach(async () => {
    if (service) {
        service.dispose();
        await Promise.resolve();
        service = null;
    }

    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalRelayUrl === undefined) delete process.env.PIZZAPI_RELAY_URL;
    else process.env.PIZZAPI_RELAY_URL = originalRelayUrl;
    if (originalApiKey === undefined) delete process.env.PIZZAPI_RUNNER_API_KEY;
    else process.env.PIZZAPI_RUNNER_API_KEY = originalApiKey;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

class MockProvider implements MessageProvider {
    readonly id: string;
    readonly label: string;
    connected = false;
    private readonly handlers = new Set<InboundMessageHandler>();
    private config: ProviderConfig | null = null;
    private shouldFailConnect = false;
    private shouldFailSend = false;

    constructor(id: string, label: string, options?: { failConnect?: boolean; failSend?: boolean }) {
        this.id = id;
        this.label = label;
        this.shouldFailConnect = options?.failConnect ?? false;
        this.shouldFailSend = options?.failSend ?? false;
    }

    connect = mock((config: ProviderConfig) => {
        this.config = config;
        if (this.shouldFailConnect) {
            return Promise.reject(new Error(`${this.id} connect failed`));
        }
        this.connected = true;
        return Promise.resolve();
    });

    disconnect = mock(() => {
        this.connected = false;
        this.config = null;
        return Promise.resolve();
    });

    isConnected(): boolean {
        return this.connected;
    }

    send = mock((_channelId: string, _message: OutboundMessage) => {
        if (this.shouldFailSend) {
            return Promise.reject(new Error(`${this.id} send failed`));
        }
        return Promise.resolve();
    });

    listChannels = mock(() =>
        Promise.resolve<Channel[]>([
            { id: `${this.id}-chan-1`, name: "general", type: "text" },
        ]),
    );

    onMessage(handler: InboundMessageHandler): void {
        this.handlers.add(handler);
    }

    offMessage(handler: InboundMessageHandler): void {
        this.handlers.delete(handler);
    }

    async emitMessage(message: InboundMessage): Promise<void> {
        const promises: Promise<unknown>[] = [];
        for (const handler of this.handlers) {
            const result = handler(message);
            if (result instanceof Promise) {
                promises.push(result.catch(() => undefined));
            }
        }
        await Promise.all(promises);
    }

    getConfig(): ProviderConfig | null {
        return this.config;
    }
}

function fakeSocket(): Socket {
    return {} as Socket;
}

function setupBroadcastEnv(runnerId = "runner-test", apiKey = "test-api-key", relayUrl = "http://relay.test"): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-bridge-"));
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    writeFileSync(
        join(home, ".pizzapi", "runner.json"),
        JSON.stringify({ runnerId }),
        "utf-8",
    );
    process.env.HOME = home;
    process.env.PIZZAPI_RELAY_URL = relayUrl;
    process.env.PIZZAPI_RUNNER_API_KEY = apiKey;
    return home;
}

function relayFetchMock(): {
    fn: ReturnType<typeof mock<typeof fetch>>;
    calls: Array<{ url: unknown; init?: RequestInit }>;
} {
    const calls: Array<{ url: unknown; init?: RequestInit }> = [];
    const fn = mock(async (url: unknown, init?: RequestInit) => {
        const urlString = String(url);
        if (urlString.includes("/api/runners/") && urlString.includes("/trigger-broadcast")) {
            calls.push({ url, init });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        // Let real panel HTTP requests through.
        return originalFetch(url as RequestInfo, init);
    }) as unknown as ReturnType<typeof mock<typeof fetch>>;
    return { fn, calls };
}

function sampleInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
        id: "msg-1",
        channelId: "chan-1",
        channelName: "general",
        author: { id: "u1", username: "user1", displayName: "User One" },
        content: "!help",
        timestamp: Date.now(),
        isCommand: true,
        command: { name: "help", args: [], raw: "help" },
        raw: {},
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Full message-provider integration", () => {
    test("full message flow: inbound → router → outbound → event forwarder", async () => {
        const provider = new MockProvider("mock", "Mock Provider");
        const registry = new ProviderRegistry();
        registry.register(provider, {
            token: "token",
            defaultRouter: { mode: "commands-only", commandPrefix: "!" },
            forwardEvents: ["session.complete"],
        });

        registry.addChannelSession("mock", {
            channelId: "chan-1",
            sessionId: "sess-1",
            config: { mode: "commands-only", commandPrefix: "!" },
        });

        const routedMessages: Array<{ message: InboundMessage; route: import("./channel-router.js").RouteResult }> = [];
        registry.onRoutedMessage((message, route) => {
            routedMessages.push({ message, route });
        });

        // Inbound command message is routed.
        const inbound = sampleInbound({ channelId: "chan-1", content: "!hello world" });
        await provider.emitMessage(inbound);

        expect(routedMessages).toHaveLength(1);
        expect(routedMessages[0].route.sessionId).toBe("sess-1");
        expect(routedMessages[0].message.isCommand).toBe(true);
        expect(routedMessages[0].message.command?.name).toBe("hello");
        expect(routedMessages[0].message.command?.args).toEqual(["world"]);

        // Outbound message reaches the provider.
        await registry.send("mock", "chan-1", { content: "reply" });
        expect(provider.send).toHaveBeenCalledWith("chan-1", { content: "reply" });

        // Connect the provider so the event forwarder sees it as online.
        await registry.connect("mock");

        // Session event is forwarded to mapped channels.
        const forwarder = new EventForwarder(registry);
        await forwarder.forward({
            type: "session.complete",
            sessionId: "sess-1",
            payload: { extra: "data" },
        });

        expect(provider.send).toHaveBeenCalledTimes(2);
        const eventCall = provider.send.mock.calls[1];
        expect(eventCall[0]).toBe("chan-1");
        expect((eventCall[1] as OutboundMessage).content).toContain("sess-1 completed");

        // Cleanup.
        await registry.unregister("mock");
    });

    test("BridgeService with mock provider: init, inbound broadcast, dispose", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = new MockProvider("mock", "Mock Provider");
        const config: MessageBridgeConfig = {
            enabled: true,
            mock: { token: "mock-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { mock: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();

        // Provider is registered and connected.
        const registered = service.getRegistry().getProvider("mock");
        expect(registered).toBe(provider);
        expect(provider.isConnected()).toBe(true);

        // Inbound message triggers a broadcast.
        const inbound = sampleInbound({ channelId: "chan-1", content: "!status" });
        await provider.emitMessage(inbound);
        await Promise.resolve();

        const call = calls.find((c) => String(c.url).includes("/api/runners/runner-test/trigger-broadcast"));
        expect(call).toBeDefined();
        const body = JSON.parse(call!.init?.body as string);
        expect(body.type).toBe("message-bridge:inbound");
        expect(body.payload.providerId).toBe("mock");
        expect(body.payload.content).toBe("!status");

        // Dispose disconnects provider and stops server.
        const port = service.getPanelPort();
        expect(port).toBeGreaterThan(0);
        service.dispose();
        await Promise.resolve();

        expect(provider.disconnect).toHaveBeenCalled();
        expect(service.getPanelPort()).toBeUndefined();
        await expect(fetch(`http://localhost:${port}/api/status`)).rejects.toThrow();
    });

    test("config parsing from object creates the right providers and validates bad configs", async () => {
        const alpha = new MockProvider("alpha", "Alpha");
        const beta = new MockProvider("beta", "Beta");

        const config: MessageBridgeConfig = {
            enabled: true,
            alpha: { token: "alpha-token", defaultRouter: { mode: "all-messages" } },
            beta: { token: "beta-token", defaultRouter: { mode: "commands-only" } },
        };

        service = new MessageBridgeService({
            config,
            factories: {
                alpha: () => alpha,
                beta: () => beta,
            },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();
        await Promise.resolve();

        const ids = service.getRegistry().getProviders().map((p) => p.id).sort();
        expect(ids).toEqual(["alpha", "beta"]);
        expect(alpha.isConnected()).toBe(true);
        expect(beta.isConnected()).toBe(true);

        // Bad config should not register a provider.
        const badConfig: MessageBridgeConfig = {
            enabled: true,
            alpha: { token: "alpha-token" },
            gamma: { token: "" } as ProviderConfig,
        };

        const badService = new MessageBridgeService({
            config: badConfig,
            factories: {
                alpha: () => new MockProvider("alpha", "Alpha"),
                gamma: () => new MockProvider("gamma", "Gamma"),
            },
        });
        badService.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();
        await Promise.resolve();

        expect(badService.getRegistry().getProviders().map((p) => p.id)).toEqual(["alpha"]);
        badService.dispose();
        await Promise.resolve();
    });

    test("multiple providers route and report status independently", async () => {
        const alpha = new MockProvider("alpha", "Alpha");
        const beta = new MockProvider("beta", "Beta");

        const registry = new ProviderRegistry();
        registry.register(alpha, { token: "a" });
        registry.register(beta, { token: "b" });
        registry.connectAll();
        await Promise.resolve();

        registry.addChannelSession("alpha", {
            channelId: "alpha-chan",
            sessionId: "sess-alpha",
            config: { mode: "commands-only" },
        });
        registry.addChannelSession("beta", {
            channelId: "beta-chan",
            sessionId: "sess-beta",
            config: { mode: "commands-only" },
        });

        await registry.send("alpha", "alpha-chan", { content: "to alpha" });
        await registry.send("beta", "beta-chan", { content: "to beta" });

        expect(alpha.send).toHaveBeenCalledWith("alpha-chan", { content: "to alpha" });
        expect(beta.send).toHaveBeenCalledWith("beta-chan", { content: "to beta" });
        expect(alpha.send).not.toHaveBeenCalledWith("beta-chan", expect.anything());
        expect(beta.send).not.toHaveBeenCalledWith("alpha-chan", expect.anything());

        const statuses = registry.getStatus();
        expect(statuses).toHaveLength(2);
        const byId = Object.fromEntries(statuses.map((s) => [s.id, s])) as Record<string, ProviderStatus>;
        expect(byId.alpha.messagesOut).toBe(1);
        expect(byId.beta.messagesOut).toBe(1);
        expect(byId.alpha.sessionsMapped).toBe(1);
        expect(byId.beta.sessionsMapped).toBe(1);

        await registry.disconnectAll();
    });

    test("provider failure isolation: connect and send failures do not break other providers", async () => {
        const good = new MockProvider("good", "Good Provider");
        const badConnect = new MockProvider("bad-connect", "Bad Connect", { failConnect: true });
        const badSend = new MockProvider("bad-send", "Bad Send", { failSend: true });

        const registry = new ProviderRegistry();
        registry.register(good, { token: "g" });
        registry.register(badConnect, { token: "bc" });
        registry.register(badSend, { token: "bs" });

        await registry.connectAll();

        expect(good.isConnected()).toBe(true);
        expect(badConnect.isConnected()).toBe(false);
        expect(badSend.isConnected()).toBe(true);

        await expect(registry.send("good", "chan", { content: "ok" })).resolves.toBeUndefined();
        await expect(registry.send("bad-send", "chan", { content: "fail" })).rejects.toThrow("bad-send send failed");

        // Good provider remains usable after another provider's send failure.
        await expect(registry.send("good", "chan", { content: "still ok" })).resolves.toBeUndefined();

        const goodStatus = registry.getStatus().find((s) => s.id === "good");
        expect(goodStatus?.messagesOut).toBe(2);

        await registry.disconnectAll();
    });
});

describe("Manifest and packaging verification", () => {
    test("bridge-manifest.json is valid JSON with required fields", () => {
        const raw = readFileSync(join(import.meta.dir, "bridge-manifest.json"), "utf-8");
        const manifest = JSON.parse(raw) as Record<string, unknown>;

        expect(typeof manifest.id).toBe("string");
        expect(manifest.id).toBe("message-bridge");
        expect(typeof manifest.label).toBe("string");
        expect(manifest.label).toBe("Message Bridge");
        expect(typeof manifest.icon).toBe("string");
        expect(typeof manifest.panel).toBe("object");
        expect(typeof (manifest.panel as Record<string, unknown>).dir).toBe("string");
        expect(Array.isArray(manifest.triggers)).toBe(true);
        expect(manifest.triggers).toHaveLength(2);

        for (const trigger of manifest.triggers as Array<Record<string, unknown>>) {
            expect(typeof trigger.type).toBe("string");
            expect(typeof trigger.label).toBe("string");
            expect(trigger.type).toMatch(/^message-bridge:[a-z-]+$/);
            expect(typeof trigger.schema).toBe("object");
        }
    });

    test("index.ts exports all required types and classes", async () => {
        const exports = await import("./index.js");

        expect(exports.MessageBridgeService).toBeFunction();
        expect(exports.ProviderRegistry).toBeFunction();
        expect(exports.ChannelRouter).toBeFunction();
        expect(exports.EventForwarder).toBeFunction();
        expect(exports.DiscordProvider).toBeFunction();

        // Types are erased at runtime; ensure the module at least exports
        // the concrete implementations that consumers need.
        expect(Object.keys(exports).length).toBeGreaterThanOrEqual(6);
    });

    test("panel/index.html is well-formed HTML", () => {
        const raw = readFileSync(join(import.meta.dir, "panel", "index.html"), "utf-8");

        expect(raw.trim().toLowerCase().startsWith("<!doctype html>")).toBe(true);
        expect(raw).toContain("<html");
        expect(raw).toContain("</html>");
        expect(raw).toContain("<head>");
        expect(raw).toContain("</head>");
        expect(raw).toContain("<body>");
        expect(raw).toContain("</body>");
        expect(raw).toContain('id="providers"');
        expect(raw).toContain('id="config-form"');

        // Opening and closing tags should be balanced at the top level.
        const tagPattern = /<(\/?)(html|head|body|title|script|style|div|form|textarea|input|button|h1|h2|ul|li|span)[^>]*>/gi;
        let depth = 0;
        for (const match of raw.matchAll(tagPattern)) {
            const closing = match[1] === "/";
            const selfClosingTags = ["input"];
            if (selfClosingTags.includes(match[2].toLowerCase())) continue;
            depth += closing ? -1 : 1;
            expect(depth).toBeGreaterThanOrEqual(0);
        }
    });
});
