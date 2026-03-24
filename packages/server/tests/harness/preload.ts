/**
 * Bun test preload script — captures the real redis createClient before any
 * mock.module("redis", ...) calls replace it.
 *
 * Bun runs this file BEFORE evaluating any test file (including before the
 * hoisted mock.module() calls in test files). By saving the real createClient
 * to globalThis here, the test harness can always access the genuine redis
 * client factory regardless of what other test files mock.
 *
 * Referenced from bunfig.toml:
 *   [test]
 *   preload = ["./packages/server/tests/harness/preload.ts"]
 */

import { createClient } from "redis";

// Type augmentation so TypeScript knows about the global
declare global {
    // eslint-disable-next-line no-var
    var __realRedisCreateClient: typeof createClient | undefined;
}

globalThis.__realRedisCreateClient = createClient;
