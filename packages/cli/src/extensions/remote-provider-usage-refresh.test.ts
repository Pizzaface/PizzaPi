import { afterAll, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;
const credentials: Record<string, { access: string }> = {
    anthropic: { access: "test-rejected-token" },
    "claude-subscription": { access: "test-claude-token" },
    "openai-codex": { access: "test-codex-token" },
};
mock.module("@earendil-works/pi-coding-agent", () => ({
    readStoredCredential: (provider: string) => credentials[provider],
}));
mock.module("../config.js", () => ({
    loadConfig: () => ({}), defaultAgentDir: () => "/test-only/agent", expandHome: (path: string) => path,
}));
mock.module("../runner/usage-auth.js", () => ({
    getOAuthAccessToken: (value: { access?: string } | undefined) => value?.access ?? null,
    getAnthropicKeychainToken: () => null,
}));
const originalCachePath = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
const { refreshAllUsage, buildProviderUsage } = await import("./remote-provider-usage.js");
afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalCachePath === undefined) delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
    else process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = originalCachePath;
    mock.restore();
});

test("real standalone refresh falls back from rejected Anthropic auth and marks both providers unknown on 5xx", async () => {
    const reset = new Date(Date.now() + 3600_000).toISOString();
    const tokens: string[] = [];
    let failing = false;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const token = new Headers(init?.headers).get("Authorization") ?? "";
        tokens.push(token);
        if (failing) return new Response("unavailable", { status: 503 });
        if (token === "Bearer test-rejected-token") return new Response("rejected", { status: 401 });
        return Response.json(String(input).includes("anthropic")
            ? { five_hour: { utilization: 40, resets_at: reset } }
            : { rate_limit: { primary_window: { used_percent: 30, reset_at: Date.parse(reset) / 1000, limit_window_seconds: 18000 } } });
    });
    globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} });
    await refreshAllUsage({ force: true });
    const success = buildProviderUsage();
    expect(success.anthropic?.status).toBe("ok");
    expect(success["openai-codex"]?.status).toBe("ok");
    expect(tokens).toContain("Bearer test-claude-token");
    failing = true;
    await refreshAllUsage({ force: true });
    const failure = buildProviderUsage();
    for (const id of ["anthropic", "openai-codex"]) {
        expect(failure[id]?.status).toBe("unknown");
        expect(failure[id]?.errorCode).toBe(503);
        expect(failure[id]?.windows).toEqual(success[id]?.windows);
        expect(failure[id]?.fetchedAt).toBe(success[id]?.fetchedAt);
    }
    const requests = fetchMock.mock.calls.length;
    await refreshAllUsage({ force: true });
    expect(fetchMock.mock.calls.length).toBe(requests);
});
