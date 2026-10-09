/**
 * Bun test preload — captures the real Redis createClient before any
 * mock.module("redis", …) calls in other test files can replace it.
 */
import { mock } from "bun:test";
import * as redisModule from "redis";
import { createClient } from "redis";
import type { RedisClientType } from "redis";

type CreateClient = (...args: Parameters<typeof createClient>) => RedisClientType;
const realCreateClient = createClient as CreateClient;

const globals = globalThis as unknown as Record<string, unknown>;
globals.__harnessRedisConnectUrls ??= [] as string[];

function assertNotDefaultDevRedis(url: unknown): void {
    if (typeof url !== "string") return;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const port = parsed.port || "6379";
        const usesDefaultDb = parsed.pathname === "" || parsed.pathname === "/" || parsed.pathname === "/0";
        if (parsed.protocol === "redis:" && port === "6379" && usesDefaultDb && (host === "localhost" || host === "127.0.0.1")) {
            throw new Error(
                `[test-harness] Refusing to connect to live dev Redis at ${url}. ` +
                "Use RedisMemoryServer or another isolated PIZZAPI_REDIS_URL for server tests.",
            );
        }
    } catch (err) {
        if (err instanceof Error && err.message.startsWith("[test-harness]")) throw err;
    }
}

const guardedCreateClient = ((...args: Parameters<typeof createClient>) => {
    const options = args[0] as { url?: string } | undefined;
    const client = realCreateClient(...args) as RedisClientType;
    const connect = client.connect.bind(client);
    client.connect = (async (...connectArgs: Parameters<typeof client.connect>) => {
        const url = options?.url ?? process.env.PIZZAPI_REDIS_URL ?? "redis://127.0.0.1:6379";
        (globals.__harnessRedisConnectUrls as string[]).push(String(url));
        assertNotDefaultDevRedis(url);
        return connect(...connectArgs);
    }) as typeof client.connect;
    return client;
}) as CreateClient;

globals.__harnessRealCreateClient = guardedCreateClient;

mock.module("redis", () => ({
    ...redisModule,
    createClient: guardedCreateClient,
}));
