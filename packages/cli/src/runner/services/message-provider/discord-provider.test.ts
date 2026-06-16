import { describe, test, expect, mock } from "bun:test";
import { ChannelType, type Client, type Guild, type Message, type TextChannel } from "discord.js";
import { DiscordProvider } from "./discord-provider.js";
import type { InboundMessageHandler, OutboundMessage, ProviderConfig } from "./types.js";

type MockClient = Client & { emit: (event: string, ...args: unknown[]) => void };
type MockFn = ReturnType<typeof mock<(...args: unknown[]) => unknown>>;

function createMockClient(): MockClient {
    const events = new Map<string, Function[]>();
    const client = {
        login: mock(() => Promise.resolve()),
        destroy: mock(() => {}),
        removeAllListeners: mock(() => {
            events.clear();
        }),
        once: mock((event: string, cb: Function) => {
            events.set(event, [cb]);
        }),
        on: mock((event: string, cb: Function) => {
            if (!events.has(event)) {
                events.set(event, []);
            }
            events.get(event)!.push(cb);
        }),
        channels: {
            fetch: mock((_id: string) => Promise.resolve(null)) as unknown as (
                id: string,
            ) => Promise<import("discord.js").Channel | null>,
        },
        guilds: {
            cache: new Map(),
        },
        emit: (event: string, ...args: unknown[]) => {
            for (const cb of events.get(event) ?? []) {
                cb(...args);
            }
        },
    } as unknown as MockClient;
    return client;
}

function createMockMessage(overrides: Record<string, unknown> = {}): Message {
    const channel = (overrides.channel as { name?: string } | undefined) ?? {
        name: "general",
        isTextBased: () => true,
    };
    return {
        id: "msg-1",
        channelId: "chan-1",
        channel,
        content: "hello world",
        createdTimestamp: 1234567890,
        author: {
            id: "user-1",
            username: "testuser",
            displayName: "Test User",
        },
        reference: undefined,
        thread: undefined,
        ...overrides,
    } as unknown as Message;
}

function createMockTextChannel(overrides: Record<string, unknown> = {}): TextChannel {
    return {
        id: "chan-1",
        name: "general",
        type: ChannelType.GuildText,
        isTextBased: () => true,
        send: mock(() => Promise.resolve({})),
        ...overrides,
    } as unknown as TextChannel;
}

function asHandler(mockFn: MockFn): InboundMessageHandler {
    return mockFn as unknown as InboundMessageHandler;
}

describe("DiscordProvider", () => {
    test("has expected id and label", () => {
        const provider = new DiscordProvider();
        expect(provider.id).toBe("discord");
        expect(provider.label).toBe("Discord");
    });

    test("connect attaches listeners and login is called with token", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);

        await provider.connect({ token: "bot-token" });

        expect(client.login).toHaveBeenCalledWith("bot-token");
        expect(provider.isConnected()).toBe(false);

        client.emit("ready");
        expect(provider.isConnected()).toBe(true);
    });

    test("disconnect destroys client and clears state", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);

        await provider.connect({ token: "bot-token" });
        client.emit("ready");
        expect(provider.isConnected()).toBe(true);

        await provider.disconnect();
        expect(client.destroy).toHaveBeenCalled();
        expect(client.removeAllListeners).toHaveBeenCalled();
        expect(provider.isConnected()).toBe(false);
    });

    test("login failure is surfaced gracefully", async () => {
        const client = createMockClient();
        client.login = mock(() => Promise.reject(new Error("invalid token")));
        const provider = new DiscordProvider(client);

        await expect(provider.connect({ token: "bad-token" })).rejects.toThrow("invalid token");
        expect(provider.isConnected()).toBe(false);
    });

    test("message conversion produces expected InboundMessage shape", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const reference = { messageId: "reply-target" };
        const thread = { id: "thread-1" };
        const discordMessage = createMockMessage({
            id: "msg-2",
            channelId: "chan-2",
            channel: { name: "dev" },
            content: "plain text",
            createdTimestamp: 42,
            author: { id: "user-2", username: "u2", displayName: "Display Two" },
            reference,
            thread,
        });

        const inbound = provider._convertMessage(discordMessage);

        expect(inbound.id).toBe("msg-2");
        expect(inbound.channelId).toBe("chan-2");
        expect(inbound.channelName).toBe("dev");
        expect(inbound.author).toEqual({ id: "user-2", username: "u2", displayName: "Display Two" });
        expect(inbound.content).toBe("plain text");
        expect(inbound.timestamp).toBe(42);
        expect(inbound.isCommand).toBe(false);
        expect(inbound.command).toBeUndefined();
        expect(inbound.replyToId).toBe("reply-target");
        expect(inbound.threadId).toBe("thread-1");
        expect(inbound.raw).toBe(discordMessage);
    });

    test("command detection with default prefix", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const commandMsg = provider._convertMessage(createMockMessage({ content: "!run tests --watch" }));
        expect(commandMsg.isCommand).toBe(true);
        expect(commandMsg.command).toEqual({ name: "run", args: ["tests", "--watch"], raw: "run tests --watch" });

        const normalMsg = provider._convertMessage(createMockMessage({ content: "hello" }));
        expect(normalMsg.isCommand).toBe(false);
        expect(normalMsg.command).toBeUndefined();
    });

    test("custom command prefix from default router", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        const config: ProviderConfig = {
            token: "bot-token",
            defaultRouter: { mode: "commands-only", commandPrefix: "/" },
        };
        await provider.connect(config);

        const commandMsg = provider._convertMessage(createMockMessage({ content: "/deploy prod" }));
        expect(commandMsg.isCommand).toBe(true);
        expect(commandMsg.command).toEqual({ name: "deploy", args: ["prod"], raw: "deploy prod" });

        const ignoredMsg = provider._convertMessage(createMockMessage({ content: "!something" }));
        expect(ignoredMsg.isCommand).toBe(false);
    });

    test("send routes to the fetched text channel", async () => {
        const client = createMockClient();
        const channel = createMockTextChannel({ id: "chan-1", name: "general" });
        client.channels.fetch = mock(() => Promise.resolve(channel)) as unknown as typeof client.channels.fetch;
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const outbound: OutboundMessage = { content: "hello channel" };
        await provider.send("chan-1", outbound);

        expect(client.channels.fetch).toHaveBeenCalledWith("chan-1");
        expect(channel.send).toHaveBeenCalledWith({ content: "hello channel" });
    });

    test("send with replyToId includes message reference", async () => {
        const client = createMockClient();
        const channel = createMockTextChannel({ id: "chan-1" });
        client.channels.fetch = mock(() => Promise.resolve(channel)) as unknown as typeof client.channels.fetch;
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        await provider.send("chan-1", { content: "replying", replyToId: "original-msg" });

        expect(channel.send).toHaveBeenCalledWith({
            content: "replying",
            reply: { messageReference: "original-msg" },
        });
    });

    test("send with threadId targets the thread", async () => {
        const client = createMockClient();
        const thread = createMockTextChannel({ id: "thread-1", name: "thread" });
        client.channels.fetch = mock((id: string) => {
            return id === "thread-1" ? Promise.resolve(thread) : Promise.resolve(null);
        }) as unknown as typeof client.channels.fetch;
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        await provider.send("chan-1", { content: "in thread", threadId: "thread-1" });

        expect(client.channels.fetch).toHaveBeenCalledWith("thread-1");
        expect(thread.send).toHaveBeenCalledWith({ content: "in thread" });
    });

    test("send throws when channel is not text-based", async () => {
        const client = createMockClient();
        const voiceChannel = { id: "voice-1", isTextBased: () => false };
        client.channels.fetch = mock(() => Promise.resolve(voiceChannel)) as unknown as typeof client.channels.fetch;
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        await expect(provider.send("voice-1", { content: "hello" })).rejects.toThrow("not text-based");
    });

    test("send throws when not connected", async () => {
        const provider = new DiscordProvider();
        await expect(provider.send("chan-1", { content: "hello" })).rejects.toThrow("not connected");
    });

    test("listChannels collects guild text channels", async () => {
        const client = createMockClient();
        const guild = {
            channels: {
                cache: new Map([
                    ["text-1", { id: "text-1", name: "general", type: ChannelType.GuildText }],
                    ["voice-1", { id: "voice-1", name: "voice", type: ChannelType.GuildVoice }],
                    ["text-2", { id: "text-2", name: "dev", type: ChannelType.GuildText }],
                ]),
            },
        };
        client.guilds.cache.set("guild-1", guild as unknown as Guild);

        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const channels = await provider.listChannels();
        expect(channels).toHaveLength(2);
        expect(channels).toContainEqual({ id: "text-1", name: "general", type: "text" });
        expect(channels).toContainEqual({ id: "text-2", name: "dev", type: "text" });
    });

    test("onMessage registers handler and offMessage removes it", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const handlerMock = mock(() => {});
        const handler = asHandler(handlerMock);
        provider.onMessage(handler);

        client.emit("ready");
        client.emit("messageCreate", createMockMessage({ content: "ping" }));
        await Promise.resolve();
        await Promise.resolve();
        expect(handlerMock).toHaveBeenCalled();

        provider.offMessage(handler);
        handlerMock.mockClear?.();
        client.emit("messageCreate", createMockMessage({ content: "pong" }));
        await Promise.resolve();
        await Promise.resolve();
        expect(handlerMock).not.toHaveBeenCalled();
    });

    test("one throwing handler does not break other handlers", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const goodHandlerMock = mock(() => {});
        const badHandlerMock = mock(() => {
            throw new Error("boom");
        });

        provider.onMessage(asHandler(badHandlerMock));
        provider.onMessage(asHandler(goodHandlerMock));

        client.emit("messageCreate", createMockMessage({ content: "test" }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(badHandlerMock).toHaveBeenCalled();
        expect(goodHandlerMock).toHaveBeenCalled();
    });

    test("DM channel name falls back", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });

        const dmMessage = createMockMessage({
            channelId: "dm-1",
            channel: {},
            content: "hi",
        });

        const inbound = provider._convertMessage(dmMessage);
        expect(inbound.channelName).toBe("DM");
    });

    test("detects bot mention in message", async () => {
        const client = createMockClient();
        (client as unknown as Record<string, unknown>).user = { id: "bot-123" };
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "bot-token" });
        client.emit("ready");

        const mentioned = createMockMessage({ content: "<@bot-123> help me please" });
        expect(provider._convertMessage(mentioned).mentionedBot).toBe(true);

        const notMentioned = createMockMessage({ content: "hello world" });
        expect(provider._convertMessage(notMentioned).mentionedBot).toBe(false);
    });

    test("detects bot mention with @! syntax", async () => {
        const client = createMockClient();
        (client as unknown as Record<string, unknown>).user = { id: "bot-456" };
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "t" });
        client.emit("ready");

        const msg = createMockMessage({ content: "<@!bot-456> do stuff" });
        expect(provider._convertMessage(msg).mentionedBot).toBe(true);
    });

    test("parses content after mention into a command", async () => {
        const client = createMockClient();
        (client as unknown as Record<string, unknown>).user = { id: "bot-789" };
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "t" });
        client.emit("ready");

        const msg = createMockMessage({ content: "<@bot-789> status all" });
        const inbound = provider._convertMessage(msg);
        expect(inbound.mentionedBot).toBe(true);
        expect(inbound.isCommand).toBe(true);
        expect(inbound.command?.name).toBe("status");
        expect(inbound.command?.args).toEqual(["all"]);
    });

    test("bare mention becomes ping command", async () => {
        const client = createMockClient();
        (client as unknown as Record<string, unknown>).user = { id: "bot-999" };
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "t" });
        client.emit("ready");

        const msg = createMockMessage({ content: "<@bot-999>" });
        const inbound = provider._convertMessage(msg);
        expect(inbound.mentionedBot).toBe(true);
        expect(inbound.command?.name).toBe("ping");
        expect(inbound.command?.args).toEqual([]);
    });

    test("does not detect mention if bot is not ready or no bot user", async () => {
        const client = createMockClient();
        const provider = new DiscordProvider(client);
        await provider.connect({ token: "t" });
        // Do NOT emit ready — botUserId stays null

        const msg = createMockMessage({ content: "<@some-id> hi" });
        const inbound = provider._convertMessage(msg);
        expect(inbound.mentionedBot).toBe(false);
    });
});
