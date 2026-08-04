import { describe, expect, test } from "bun:test";
import { registerProviderAuthHandlers, type AuthRuntime } from "./provider-auth.js";

/** Socket double: records emits, lets tests fire inbound events. */
function fakeSocket() {
    const handlers = new Map<string, (data: any) => void>();
    const emits: { event: string; data: any }[] = [];
    return {
        socket: {
            on(event: string, fn: (data: any) => void) {
                handlers.set(event, fn);
            },
            emit(event: string, data: any) {
                emits.push({ event, data });
            },
        } as any,
        fire: (event: string, data: any) => handlers.get(event)?.(data),
        emits,
        /** Wait for the reply carrying this requestId. */
        async reply(requestId: string, timeoutMs = 2000): Promise<any> {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const hit = emits.find((e) => e.data?.requestId === requestId);
                if (hit) return hit.data;
                await new Promise((r) => setTimeout(r, 5));
            }
            throw new Error(`No reply for ${requestId}`);
        },
    };
}

/** Anthropic-shaped flow: emits an auth URL, then waits for a pasted code. */
function fakeRuntime(): { runtime: AuthRuntime; loggedIn: string[] } {
    const loggedIn: string[] = [];
    return {
        loggedIn,
        runtime: {
            getProviders: () => [
                { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: { login: () => {} } } },
                { id: "ambient-only", name: "Ambient", auth: { apiKey: {} } },
            ],
            getProvider: (id) => (id === "anthropic" ? { auth: { oauth: {}, apiKey: { login: () => {} } } } : undefined),
            listCredentials: async () => [{ providerId: "anthropic" }],
            login: async (providerId, _type, interaction) => {
                interaction.notify({ type: "auth_url", url: "https://example.test/authorize" });
                const code = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
                if (code !== "the-code") throw new Error("bad code");
                loggedIn.push(providerId);
                return {};
            },
        },
    };
}

describe("provider auth handlers", () => {
    test("lists only providers with an interactive login", async () => {
        const { socket, fire, reply } = fakeSocket();
        const { runtime } = fakeRuntime();
        registerProviderAuthHandlers(socket, () => false, () => "/tmp/agent", async () => runtime);

        fire("auth_list", { requestId: "r1" });
        const res = await reply("r1");
        expect(res.ok).toBe(true);
        expect(res.providers).toEqual([
            { id: "anthropic", name: "Anthropic", types: ["oauth", "api_key"], configured: true },
        ]);
    });

    test("start returns the auth URL + prompt, submit completes the login", async () => {
        const { socket, fire, reply } = fakeSocket();
        const { runtime, loggedIn } = fakeRuntime();
        registerProviderAuthHandlers(socket, () => false, () => "/tmp/agent", async () => runtime);

        fire("auth_login_start", { requestId: "r2", providerId: "anthropic", authType: "oauth" });
        const started = await reply("r2");
        expect(started.ok).toBe(true);
        expect(started.step.state).toBe("prompt");
        expect(started.step.authUrl).toBe("https://example.test/authorize");
        expect(started.step.prompt.message).toContain("Paste");

        fire("auth_login_submit", { requestId: "r3", loginId: started.step.loginId, value: "the-code" });
        const done = await reply("r3");
        expect(done.step).toEqual({ state: "done", providerId: "anthropic" });
        expect(loggedIn).toEqual(["anthropic"]);
    });

    test("a failed flow reports the error and clears the pending login", async () => {
        const { socket, fire, reply } = fakeSocket();
        const { runtime } = fakeRuntime();
        registerProviderAuthHandlers(socket, () => false, () => "/tmp/agent", async () => runtime);

        fire("auth_login_start", { requestId: "r4", providerId: "anthropic", authType: "oauth" });
        const started = await reply("r4");
        fire("auth_login_submit", { requestId: "r5", loginId: started.step.loginId, value: "wrong" });
        const failed = await reply("r5");
        expect(failed.step.state).toBe("error");
        expect(failed.step.message).toContain("bad code");

        // Stale login id is rejected rather than hanging the next request.
        fire("auth_login_submit", { requestId: "r6", loginId: started.step.loginId, value: "x" });
        const stale = await reply("r6");
        expect(stale.ok).toBe(false);
        expect(stale.message).toContain("No login in progress");
    });

    test("status poll reports a login the loopback callback finished", async () => {
        const { socket, fire, reply } = fakeSocket();
        const { runtime } = fakeRuntime();
        registerProviderAuthHandlers(socket, () => false, () => "/tmp/agent", async () => runtime);

        fire("auth_login_start", { requestId: "s1", providerId: "anthropic", authType: "oauth" });
        const started = await reply("s1");
        const loginId = started.step.loginId;

        // Still waiting on input — nothing to report yet.
        fire("auth_login_status", { requestId: "s2", loginId });
        expect((await reply("s2")).step).toEqual({ state: "waiting" });

        // Flow completes without anyone awaiting a step (the callback won).
        fire("auth_login_submit", { requestId: "s3", loginId, value: "the-code" });
        await reply("s3");

        fire("auth_login_status", { requestId: "s4", loginId });
        expect((await reply("s4")).step).toEqual({ state: "done", providerId: "anthropic" });
    });

    test("rejects a login type the provider does not support", async () => {
        const { socket, fire, reply } = fakeSocket();
        const { runtime } = fakeRuntime();
        registerProviderAuthHandlers(socket, () => false, () => "/tmp/agent", async () => runtime);

        fire("auth_login_start", { requestId: "r7", providerId: "ambient-only", authType: "oauth" });
        const res = await reply("r7");
        expect(res.ok).toBe(false);
    });
});
