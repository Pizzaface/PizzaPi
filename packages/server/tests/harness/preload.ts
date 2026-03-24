/**
 * Bun test preload — captures the real Redis createClient before any
 * mock.module("redis", …) calls in other test files can replace it.
 */
import { createClient } from "redis";
import type { RedisClientType } from "redis";

type CreateClient = (...args: Parameters<typeof createClient>) => RedisClientType;
(globalThis as unknown as Record<string, unknown>).__harnessRealCreateClient =
    createClient as CreateClient;
