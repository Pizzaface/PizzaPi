/**
 * Tests for MessageBridgeService.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { MessageBridgeService, type MessageBridgeConfig } from "./bridge-service.js";
import type { Channel, InboundMessage, InboundMessageHandler, MessageProvider, OutboundMessage, ProviderConfig } from "./types.js";

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

    constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
    }

    connect = mock((config: ProviderConfig) => {
        this.connected = true;
        return Promise.resolve();
    });

    disconnect = mock(() => {
        this.connected = false;
        return Promise.resolve();
    });

    isConnected(): boolean {
        return this.connected;
    }

    send = mock((_channelId: string, _message: OutboundMessage) => Promise.resolve());

    listChannels = mock(() =>
        Promise.resolve<Channel[]>([
            { id: "chan-1", name: "general", type: "text" },
            { id: "chan-2", name: "dev", type: "text" },
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
}

function createMockProvider(id: string, label: string): MockProvider {
    return new MockProvider(id, label);
}

function fakeSocket(): Socket {
    return {} as Socket;
}

function setupBroadcastEnv(): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-bridge-"));
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    writeFileSync(
        join(home, ".pizzapi", "runner.json"),
        JSON.stringify({ runnerId: "runner-test" }),
        "utf-8",
    );
    process.env.HOME = home;
    process.env.PIZZAPI_RELAY_URL = "http://relay.test";
    process.env.PIZZAPI_RUNNER_API_KEY = "test-api-key";
    return home;
}

function relayFetchMock(): {
    fn: ReturnType<typeof mock<typeof fetch>>;
    calls: Array<{ url: unknown; init?: RequestInit }>;
} {
    const calls: Array<{ url: unknown; init?: RequestInit }> = [];
    const fn = mock(async (url: unknown, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as ReturnType<typeof mock<typeof fetch>>;
    return { fn, calls };
}

function mixedFetchMock(): {
    fn: ReturnType<typeof mock<typeof fetch>>;
    relayCalls: Array<{ url: unknown; init?: RequestInit }>;
} {
    const relayCalls: Array<{ url: unknown; init?: RequestInit }> = [];
    const fn = mock(async (url: unknown, init?: RequestInit) => {
        const urlString = String(url);
        if (urlString.includes("/api/runners/") && urlString.includes("/trigger-broadcast")) {
            relayCalls.push({ url, init });
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        // Let real panel HTTP requests through.
        return originalFetch(url as RequestInfo, init);
    }) as unknown as ReturnType<typeof mock<typeof fetch>>;
    return { fn, relayCalls };
}

function sampleInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
        id: "msg-1",
        channelId: "chan-1",
        channelName: "general",
        author: { id: "u1", username: "user1", displayName: "User One" },
        content: "hello",
        timestamp: Date.now(),
        isCommand: false,
        raw: {},
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MessageBridgeService", () => {
    test("has expected id", () => {
        service = new MessageBridgeService();
        expect(service.id).toBe("message-bridge");
    });

    test("init() registers providers based on config", async () => {
        const discord = createMockProvider("discord", "Discord");
        const slack = createMockProvider("slack", "Slack");

        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
            slack: { token: "slack-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: {
                discord: () => discord,
                slack: () => slack,
            },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();
        await Promise.resolve();

        const providers = service.getRegistry().getProviders();
        expect(providers.map((p) => p.id).sort()).toEqual(["discord", "slack"]);
        expect(discord.connect).toHaveBeenCalled();
        expect(slack.connect).toHaveBeenCalled();
    });

    test("providers that fail to connect are handled gracefully", async () => {
        const good = createMockProvider("good", "Good Provider");
        const bad = createMockProvider("bad", "Bad Provider");
        bad.connect = mock(() => {
            bad.connected = false;
            return Promise.reject(new Error("login failed"));
        });

        const config: MessageBridgeConfig = {
            enabled: true,
            good: { token: "good-token" },
            bad: { token: "bad-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: {
                good: () => good,
                bad: () => bad,
            },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();
        await Promise.resolve();

        expect(good.connect).toHaveBeenCalled();
        expect(bad.connect).toHaveBeenCalled();
        expect(good.isConnected()).toBe(true);
        expect(bad.isConnected()).toBe(false);
    });

    test("provider status reports correctly", () => {
        const provider = createMockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        provider.connected = true;
        service.getRegistry().addChannelSession("discord", {
            channelId: "chan-1",
            sessionId: "sess-1",
            config: { mode: "commands-only" },
        });

        const status = service.getRegistry().getStatus();
        expect(status).toHaveLength(1);
        expect(status[0]).toMatchObject({
            id: "discord",
            label: "Discord",
            connected: true,
            channelCount: 1,
            sessionsMapped: 1,
            messagesIn: 0,
            messagesOut: 0,
        });
    });

    test("inbound messages trigger broadcast via fetch", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = createMockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();

        const inbound = sampleInbound({ content: "!help" });
        await provider.emitMessage(inbound);
        await Promise.resolve();

        expect(calls.length).toBeGreaterThanOrEqual(1);
        const call = calls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(call).toBeDefined();
        expect(call!.init?.method).toBe("POST");

        const body = JSON.parse(call!.init?.body as string);
        expect(body.type).toBe("message-bridge:inbound");
        expect(body.source).toBe("message-bridge");
        expect(body.payload.providerId).toBe("discord");
        expect(body.payload.channelId).toBe("chan-1");
        expect(body.payload.content).toBe("!help");
        expect(body.payload.author.displayName).toBe("User One");
        expect(body.deliverAs).toBe("followUp");
        expect(body.summary).toContain("User One");
    });

    test("panel server responds to /api/status", async () => {
        const provider = createMockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        const port = service.getPanelPort();
        expect(port).toBeGreaterThan(0);

        const res = await fetch(`http://localhost:${port}/api/status`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as Array<Record<string, unknown>>;
        expect(data).toHaveLength(1);
        expect(data[0].id).toBe("discord");
    });

    test("panel server responds to /api/send", async () => {
        setupBroadcastEnv();
        const { fn, relayCalls } = mixedFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = createMockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        const port = service.getPanelPort()!;

        const res = await fetch(`http://localhost:${port}/api/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerId: "discord", channelId: "chan-1", content: "hello" }),
        });

        expect(res.status).toBe(200);
        const data = (await res.json()) as Record<string, unknown>;
        expect(data.success).toBe(true);
        expect(provider.send).toHaveBeenCalledWith("chan-1", { content: "hello" });

        await Promise.resolve();
        const relayCall = relayCalls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(relayCall).toBeDefined();
        const body = JSON.parse(relayCall!.init?.body as string);
        expect(body.type).toBe("message-bridge:send");
        expect(body.payload.providerId).toBe("discord");
        expect(body.payload.channelId).toBe("chan-1");
        expect(body.payload.content).toBe("hello");
    });

    test("dispose() disconnects providers and stops server", async () => {
        const provider = createMockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: { token: "discord-token" },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        const port = service.getPanelPort()!;
        await Promise.resolve();

        service.dispose();
        await Promise.resolve();

        expect(provider.disconnect).toHaveBeenCalled();
        expect(service.getPanelPort()).toBeUndefined();

        // The server should no longer accept connections.
        await expect(fetch(`http://localhost:${port}/api/status`)).rejects.toThrow();
    });

    test("config validation endpoint", async () => {
        service = new MessageBridgeService({
            config: { enabled: true },
            factories: { discord: () => createMockProvider("discord", "Discord") },
        });
        service.init(fakeSocket(), { isShuttingDown: () => false });
        const port = service.getPanelPort()!;

        const valid = await fetch(`http://localhost:${port}/api/config/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discord: { token: "valid-token" } }),
        });
        const validData = (await valid.json()) as Record<string, unknown>;
        expect(valid.status).toBe(200);
        expect(validData.valid).toBe(true);

        const invalid = await fetch(`http://localhost:${port}/api/config/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ discord: {} }),
        });
        const invalidData = (await invalid.json()) as Record<string, unknown>;
        expect(invalid.status).toBe(200);
        expect(invalidData.valid).toBe(false);
    });

    test("reconcileSubscriptions tracks send sessions", () => {
        service = new MessageBridgeService();

        const snapshot: TriggerSubscriptionEntry[] = [
            { sessionId: "s1", triggerType: "message-bridge:send", subscriptionId: "sub-1", runnerId: "runner-1" },
            { sessionId: "s2", triggerType: "message-bridge:send", subscriptionId: "sub-2", runnerId: "runner-1" },
            { sessionId: "s3", triggerType: "other:event", subscriptionId: "sub-3", runnerId: "runner-1" },
        ];

        const result = service.reconcileSubscriptions(snapshot, { mode: "snapshot" });
        expect(result.applied).toBe(2);
        expect(service.getSendSessions()).toContain("s1");
        expect(service.getSendSessions()).toContain("s2");
        expect(service.getSendSessions()).not.toContain("s3");

        const deltaUnsub: TriggerSubscriptionEntry[] = [
            { sessionId: "s1", triggerType: "message-bridge:send", subscriptionId: "sub-1", runnerId: "runner-1" },
        ];
        const unsubResult = service.reconcileSubscriptions(deltaUnsub, { mode: "delta", action: "unsubscribe" });
        expect(unsubResult.applied).toBe(1);
        expect(service.getSendSessions()).not.toContain("s1");
        expect(service.getSendSessions()).toContain("s2");

        const deltaSub: TriggerSubscriptionEntry[] = [
            { sessionId: "s4", triggerType: "message-bridge:send", subscriptionId: "sub-4", runnerId: "runner-1" },
        ];
        const subResult = service.reconcileSubscriptions(deltaSub, { mode: "delta", action: "subscribe" });
        expect(subResult.applied).toBe(1);
        expect(service.getSendSessions()).toContain("s4");
    });

    test("announcePanel is called with panel port", () => {
        const announcedPorts: number[] = [];
        const provider = createMockProvider("discord", "Discord");

        service = new MessageBridgeService({
            config: { enabled: true, discord: { token: "discord-token" } },
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), {
            isShuttingDown: () => false,
            announcePanel: (port) => announcedPorts.push(port),
        });

        const port = service.getPanelPort();
        expect(port).toBeGreaterThan(0);
        expect(announcedPorts).toEqual([port!]);
    });
});
