import { describe, expect, test } from "bun:test";
import {
    DISCORD_MAX_MESSAGE,
    chunkDiscordMessage,
    createDiscordExtension,
    extractAssistantText,
    isAllowedAuthor,
    resolveDiscordSettings,
    threadName,
} from "./discord.js";

describe("resolveDiscordSettings", () => {
    test("undefined without token and channelId", () => {
        expect(resolveDiscordSettings(undefined, {})).toBeUndefined();
        expect(resolveDiscordSettings({ token: "t" }, {})).toBeUndefined();
        expect(resolveDiscordSettings({ channelId: "c" }, {})).toBeUndefined();
    });

    test("reads from config", () => {
        const s = resolveDiscordSettings({ token: "t", channelId: "c", allowedUserIds: ["1"], autoStart: true }, {});
        expect(s).toEqual({ token: "t", channelId: "c", allowedUserIds: ["1"], autoStart: true });
    });

    test("env overrides config", () => {
        const s = resolveDiscordSettings(
            { token: "cfg-token", channelId: "cfg-chan" },
            { DISCORD_TOKEN: "env-token", DISCORD_CHANNEL_ID: "env-chan" },
        );
        expect(s?.token).toBe("env-token");
        expect(s?.channelId).toBe("env-chan");
    });

    test("env alone is enough", () => {
        const s = resolveDiscordSettings(undefined, { DISCORD_TOKEN: "t", DISCORD_CHANNEL_ID: "c" });
        expect(s).toEqual({ token: "t", channelId: "c", allowedUserIds: [], autoStart: false });
    });

    test("blank strings are treated as missing", () => {
        expect(resolveDiscordSettings({ token: "  ", channelId: "c" }, {})).toBeUndefined();
    });
});

describe("isAllowedAuthor", () => {
    test("empty allowlist allows everyone", () => {
        expect(isAllowedAuthor("123", [])).toBe(true);
    });

    test("allowlist gates by id", () => {
        expect(isAllowedAuthor("123", ["123", "456"])).toBe(true);
        expect(isAllowedAuthor("789", ["123", "456"])).toBe(false);
    });
});

describe("chunkDiscordMessage", () => {
    test("short text is one chunk", () => {
        expect(chunkDiscordMessage("hello")).toEqual(["hello"]);
    });

    test("empty text is no chunks", () => {
        expect(chunkDiscordMessage("")).toEqual([]);
    });

    test("exactly max is one chunk", () => {
        const text = "a".repeat(DISCORD_MAX_MESSAGE);
        expect(chunkDiscordMessage(text)).toEqual([text]);
    });

    test("splits long text under the limit", () => {
        const text = "a".repeat(4500);
        const chunks = chunkDiscordMessage(text);
        expect(chunks.length).toBe(3);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE);
        expect(chunks.join("")).toBe(text);
    });

    test("prefers newline boundaries", () => {
        const line = "x".repeat(100);
        const text = Array(30).fill(line).join("\n"); // 3029 chars
        const chunks = chunkDiscordMessage(text);
        expect(chunks.length).toBe(2);
        // No line split across chunks
        for (const c of chunks) {
            for (const l of c.split("\n")) expect(l.length).toBe(100);
        }
        expect(chunks.join("\n")).toBe(text);
    });

    test("handles a single line longer than max", () => {
        const text = "b".repeat(2500);
        const chunks = chunkDiscordMessage(text);
        expect(chunks).toEqual(["b".repeat(2000), "b".repeat(500)]);
    });
});

describe("extractAssistantText", () => {
    test("string content passes through", () => {
        expect(extractAssistantText("  hi  ")).toBe("hi");
    });

    test("joins text blocks, skips thinking and toolCall", () => {
        expect(
            extractAssistantText([
                { type: "thinking", thinking: "hmm" },
                { type: "text", text: "part one" },
                { type: "toolCall", id: "x", name: "bash" },
                { type: "text", text: "part two" },
            ]),
        ).toBe("part one\npart two");
    });

    test("non-array, non-string content is empty", () => {
        expect(extractAssistantText(undefined)).toBe("");
        expect(extractAssistantText({})).toBe("");
    });

    test("pure tool-call content is empty", () => {
        expect(extractAssistantText([{ type: "toolCall", id: "x", name: "bash" }])).toBe("");
    });
});

describe("threadName", () => {
    const date = new Date(2026, 6, 4, 9, 5); // Jul 4, 09:05

    test("uses session name when set", () => {
        expect(threadName("Fix login bug", "/tmp/proj", date)).toBe("Fix login bug · 7/4 09:05");
    });

    test("falls back to cwd basename", () => {
        expect(threadName(undefined, "/Users/j/Projects/PizzaPi", date)).toBe("PizzaPi · 7/4 09:05");
    });

    test("stays within Discord's 100-char thread name limit", () => {
        const name = threadName("n".repeat(300), "/tmp/proj", date);
        expect(name.length).toBeLessThanOrEqual(100);
    });
});

describe("createDiscordExtension wiring", () => {
    function fakePi() {
        const handlers = new Map<string, unknown>();
        const commands = new Map<string, { handler: (args: string | undefined, ctx: unknown) => Promise<void> }>();
        return {
            on(event: string, handler: unknown) {
                handlers.set(event, handler);
            },
            registerCommand(name: string, options: any) {
                commands.set(name, options);
            },
            getSessionName: () => undefined,
            sendUserMessage: () => {},
            handlers,
            commands,
        };
    }

    test("registers /discord command and lifecycle handlers", () => {
        const pi = fakePi();
        createDiscordExtension(() => undefined)(pi as any);
        expect(pi.commands.has("discord")).toBe(true);
        for (const event of ["session_start", "session_shutdown", "agent_start", "agent_end", "message_end", "session_info_changed"]) {
            expect(pi.handlers.has(event)).toBe(true);
        }
    });

    test("/discord start without config reports configuration error", async () => {
        const pi = fakePi();
        createDiscordExtension(() => undefined)(pi as any);
        const notifications: Array<{ msg: string; level: string }> = [];
        const ctx = { cwd: "/tmp", ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) } };

        const prevToken = process.env.DISCORD_TOKEN;
        const prevChannel = process.env.DISCORD_CHANNEL_ID;
        delete process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_CHANNEL_ID;
        try {
            await pi.commands.get("discord")!.handler("start", ctx);
        } finally {
            if (prevToken !== undefined) process.env.DISCORD_TOKEN = prevToken;
            if (prevChannel !== undefined) process.env.DISCORD_CHANNEL_ID = prevChannel;
        }

        expect(notifications.length).toBe(1);
        expect(notifications[0]!.level).toBe("error");
        expect(notifications[0]!.msg).toContain("not configured");
    });

    test("/discord status without config reports not configured", async () => {
        const pi = fakePi();
        createDiscordExtension(() => undefined)(pi as any);
        const notifications: Array<{ msg: string; level: string }> = [];
        const ctx = { cwd: "/tmp", ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) } };

        const prevToken = process.env.DISCORD_TOKEN;
        const prevChannel = process.env.DISCORD_CHANNEL_ID;
        delete process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_CHANNEL_ID;
        try {
            await pi.commands.get("discord")!.handler(undefined, ctx);
        } finally {
            if (prevToken !== undefined) process.env.DISCORD_TOKEN = prevToken;
            if (prevChannel !== undefined) process.env.DISCORD_CHANNEL_ID = prevChannel;
        }

        expect(notifications[0]!.msg).toContain("Not configured");
    });
});
