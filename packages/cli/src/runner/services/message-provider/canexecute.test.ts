/**
 * Tests for the message-provider `canExecute` authorization gate.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "socket.io-client";
import { MessageBridgeService, type MessageBridgeConfig } from "./bridge-service.js";
import { ChannelRouter } from "./channel-router.js";
import { discordRoleAllowed } from "./discord-policy.js";
import type {
    CanExecuteResult,
    Channel,
    InboundMessage,
    InboundMessageHandler,
    MessageProvider,
    OutboundMessage,
    ProviderConfig,
} from "./types.js";

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
        const urlString = String(url);
        if (urlString.includes("/api/runners/") && urlString.includes("/trigger-broadcast")) {
            calls.push({ url, init });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as ReturnType<typeof mock<typeof fetch>>;
    return { fn, calls };
}

function sampleInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
        id: "msg-1",
        channelId: "chan-1",
        channelName: "general",
        author: { id: "u1", username: "user1", displayName: "User One" },
        content: "!status",
        timestamp: Date.now(),
        isCommand: true,
        command: { name: "status", args: [], raw: "status" },
        raw: {},
        ...overrides,
    };
}

function mockDiscordMessage(roles: Array<{ id: string; name: string }> = []): Record<string, unknown> {
    const cache = new Map<string, { id: string; name: string }>();
    for (const role of roles) {
        cache.set(role.id, role);
    }
    return {
        id: "msg-1",
        channelId: "ch-1",
        content: "!status",
        author: { id: "user-1", username: "alice", displayName: "Alice" },
        createdTimestamp: Date.now(),
        thread: undefined,
        reference: null,
        member: {
            roles: {
                cache,
            },
        },
        channel: { name: "dev-channel" },
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CanExecuteResult type", () => {
    test("validates allowed and reason shape", () => {
        const allowed: CanExecuteResult = { allowed: true };
        expect(allowed.allowed).toBe(true);
        expect(allowed.reason).toBeUndefined();

        const denied: CanExecuteResult = { allowed: false, reason: "unauthorized" };
        expect(denied.allowed).toBe(false);
        expect(denied.reason).toBe("unauthorized");
    });
});

describe("discordRoleAllowed policy", () => {
    test("does not match by role name — ID only", () => {
        const policy = discordRoleAllowed(["admin", "moderator"]);
        const message = sampleInbound({ raw: mockDiscordMessage([{ id: "role-1", name: "admin" }]) });

        // Role name "admin" is not a role ID — should be denied
        const result = policy(message) as CanExecuteResult;
        expect(result.allowed).toBe(false);
    });

    test("allows when member has a matching role ID", () => {
        const policy = discordRoleAllowed(["role-2"]);
        const message = sampleInbound({ raw: mockDiscordMessage([{ id: "role-2", name: "devs" }]) });

        expect(policy(message)).toEqual({ allowed: true });
    });

    test("denies when member lacks all required roles", () => {
        const policy = discordRoleAllowed(["admin"]);
        const message = sampleInbound({ raw: mockDiscordMessage([{ id: "role-3", name: "member" }]) });

        const result = policy(message) as CanExecuteResult;
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("lacks required role ID");
    });

    test("denies DM or uncached member", () => {
        const policy = discordRoleAllowed(["admin"]);
        const message = sampleInbound({ raw: { ...mockDiscordMessage(), member: undefined } });

        const result = policy(message) as CanExecuteResult;
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Guild member not available");
    });

    test("allows when allowedRoles is empty", () => {
        const policy = discordRoleAllowed([]);
        const dmMessage = sampleInbound({ raw: { ...mockDiscordMessage(), member: undefined } });

        expect(policy(dmMessage)).toEqual({ allowed: true });
    });

    test("handles missing raw data gracefully", () => {
        const policy = discordRoleAllowed(["admin"]);
        const message = sampleInbound({ raw: undefined });

        const result = policy(message) as CanExecuteResult;
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Guild member not available");
    });
});

describe("MessageBridgeService canExecute integration", () => {
    test("message with matching role triggers broadcast", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = new MockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: {
                token: "discord-token",
                options: { allowedRoles: ["role-1"] },
            },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();

        const inbound = sampleInbound({
            raw: mockDiscordMessage([{ id: "role-1", name: "admin" }]),
        });
        await provider.emitMessage(inbound);
        await Promise.resolve();

        const call = calls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(call).toBeDefined();
    });

    test("message without role is rejected and fetch is not called", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = new MockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: {
                token: "discord-token",
                options: { allowedRoles: ["role-1"] },
            },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();

        const inbound = sampleInbound({
            raw: mockDiscordMessage([{ id: "role-3", name: "member" }]),
        });
        await provider.emitMessage(inbound);
        await Promise.resolve();

        const call = calls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(call).toBeUndefined();
    });

    test("no policy lets all messages pass through", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = new MockProvider("discord", "Discord");
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

        await provider.emitMessage(sampleInbound());
        await Promise.resolve();

        const call = calls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(call).toBeDefined();
    });

    test("per-channel canExecute overrides default policy", async () => {
        setupBroadcastEnv();
        const { fn, calls } = relayFetchMock();
        globalThis.fetch = fn as unknown as typeof fetch;

        const provider = new MockProvider("discord", "Discord");
        const config: MessageBridgeConfig = {
            enabled: true,
            discord: {
                token: "discord-token",
                defaultCanExecute: discordRoleAllowed(["admin"]),
            },
        };

        service = new MessageBridgeService({
            config,
            factories: { discord: () => provider },
        });

        service.init(fakeSocket(), { isShuttingDown: () => false });
        await Promise.resolve();

        // Map a channel with its own permissive policy.
        service.getRegistry().addChannelSession("discord", {
            channelId: "chan-1",
            sessionId: "sess-1",
            config: { mode: "commands-only", canExecute: () => ({ allowed: true }) },
        });

        const inbound = sampleInbound({
            channelId: "chan-1",
            raw: mockDiscordMessage([{ id: "role-3", name: "member" }]),
        });
        await provider.emitMessage(inbound);
        await Promise.resolve();

        const call = calls.find((c) =>
            String(c.url).includes("/api/runners/runner-test/trigger-broadcast"),
        );
        expect(call).toBeDefined();
    });
});

describe("ChannelRouter with canExecute", () => {
    test("route respects an allowing policy", async () => {
        const router = new ChannelRouter();
        router.addSession({
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only", canExecute: () => ({ allowed: true }) },
        });

        const route = await router.route(sampleInbound({ channelId: "ch-1", content: "!go" }));
        expect(route).toBeDefined();
        expect(route!.shouldForward).toBe(true);
    });

    test("route respects a denying policy", async () => {
        const router = new ChannelRouter();
        router.addSession({
            channelId: "ch-1",
            sessionId: "sess-1",
            config: { mode: "commands-only", canExecute: () => ({ allowed: false, reason: "nope" }) },
        });

        const route = await router.route(sampleInbound({ channelId: "ch-1", content: "!go" }));
        expect(route).toBeDefined();
        expect(route!.shouldForward).toBe(false);
    });

    test("policy errors do not crash routing", async () => {
        const router = new ChannelRouter();
        router.addSession({
            channelId: "ch-1",
            sessionId: "sess-1",
            config: {
                mode: "commands-only",
                canExecute: () => {
                    throw new Error("policy boom");
                },
            },
        });

        const route = await router.route(sampleInbound({ channelId: "ch-1", content: "!go" }));
        expect(route).toBeDefined();
        expect(route!.shouldForward).toBe(false);
    });
});
