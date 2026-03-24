/**
 * Test preload script — saves the real redis createClient before any test
 * file can mock it via mock.module("redis", ...).
 *
 * Registered in the root bunfig.toml so it runs before any test file in
 * any package. The harness (server.ts) retrieves the real function via
 * globalThis.__realRedisCreateClient.
 *
 * This is necessary because Bun 1.3.x does NOT reset mock.module() between
 * test files in the same worker. Test files in packages/server/src/ws/ mock
 * "redis" with stubs that lack .pSubscribe(), .subscribe(), .quit(), etc.
 * Without this preload, the test-server harness tests in the same worker
 * get the mocked createClient and fail with "psubscribe is not a function".
 *
 * Fails gracefully if redis is not installed (e.g. in other packages).
 */
try {
    const { createClient } = await import("redis");
    (globalThis as any).__realRedisCreateClient = createClient;
} catch {
    // redis not installed in this package context — no-op
}
