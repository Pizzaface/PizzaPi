/**
 * Bun test preload — captures the real Redis createClient before any
 * mock.module("redis", …) calls in other test files can replace it.
 *
 * In Bun 1.x, mock.module() patches the module registry permanently for the
 * lifetime of the worker process. Test files that mock "redis" without
 * calling mock.restore() contaminate subsequent files sharing the same worker.
 * The preload runs before any test file's module-level code, so the binding
 * captured here always refers to the genuine redis module.
 *
 * The harness (createTestServer) reads __harnessRealCreateClient from
 * globalThis to create pub/sub Redis clients that are immune to mock pollution.
 */
import { createClient } from "redis";
import type { RedisClientType } from "redis";

type CreateClient = (...args: Parameters<typeof createClient>) => RedisClientType;
(globalThis as unknown as Record<string, unknown>).__harnessRealCreateClient =
    createClient as CreateClient;
