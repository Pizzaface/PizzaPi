import { afterEach, describe, expect, test } from "bun:test";
import { startSandboxApi } from "./sandbox-api.js";

type FakeSession = {
    sessionId: string;
    token: string;
    shareUrl: string;
    relay: {
        emitEvent: (sessionId: string, token: string, event: unknown) => void;
        emitSessionEnd: (sessionId: string, token: string) => void;
        socket: {
            on: (event: string, cb: (data: unknown) => void) => void;
            off: (event: string, cb: (data: unknown) => void) => void;
        };
    };
};

describe("sandbox-api", () => {
    const apis: Array<{ stop: () => void }> = [];

    afterEach(() => {
        while (apis.length > 0) {
            apis.pop()?.stop();
        }
    });

    test("GET / returns HTML landing page and /openapi.json returns schema", async () => {
        const sessions: FakeSession[] = [
            {
                sessionId: "s1",
                token: "t1",
                shareUrl: "http://share/1",
                relay: {
                    emitEvent: () => {},
                    emitSessionEnd: () => {},
                    socket: { on: () => {}, off: () => {} },
                },
            },
        ];
        const scenario = {
            sessions,
            server: {
                baseUrl: "http://127.0.0.1:9999",
                userEmail: "test@example.com",
                apiKey: "key-123",
            },
            addSession: async () => { throw new Error("unused"); },
        } as any;

        const api = await startSandboxApi({
            scenario,
            scenarios: { review: { name: "Review", builder: () => [] } },
            models: [{ provider: "x", id: "m1", name: "Model 1", contextWindow: 1 }],
            cwds: ["/tmp"],
        });
        apis.push(api);

        const landing = await fetch(`${api.baseUrl}/`);
        expect(landing.ok).toBe(true);
        const html = await landing.text();
        expect(html).toContain("PizzaPi Sandbox Control API");
        expect(html).toContain("/openapi.json");
        expect(html).toContain("test@example.com");

        const openapiRes = await fetch(`${api.baseUrl}/openapi.json`);
        expect(openapiRes.ok).toBe(true);
        const spec = await openapiRes.json() as any;
        expect(spec.openapi).toBe("3.1.0");
        expect(spec.paths["/oauth"]).toBeDefined();
        expect(spec["x-scenarios"]).toContain("review");
        expect(spec.servers[0].url).toBe(api.baseUrl);
    });

    test("GET /status returns sessions and credentials", async () => {
        const emitted: unknown[] = [];
        const sessions: FakeSession[] = [
            {
                sessionId: "s1",
                token: "t1",
                shareUrl: "http://share/1",
                relay: {
                    emitEvent: (_sid, _token, event) => emitted.push(event),
                    emitSessionEnd: () => {},
                    socket: { on: () => {}, off: () => {} },
                },
            },
        ];
        const scenario = {
            sessions,
            server: {
                baseUrl: "http://127.0.0.1:9999",
                userEmail: "test@example.com",
                apiKey: "key-123",
            },
            addSession: async () => { throw new Error("unused"); },
        } as any;

        const api = await startSandboxApi({
            scenario,
            scenarios: { demo: { name: "Demo", builder: () => [] } },
            models: [{ provider: "x", id: "m1", name: "Model 1", contextWindow: 1 }],
            cwds: ["/tmp"],
        });
        apis.push(api);

        const res = await fetch(`${api.baseUrl}/status`);
        expect(res.ok).toBe(true);
        const json = await res.json() as any;
        expect(json.serverUrl).toBe("http://127.0.0.1:9999");
        expect(json.credentials.email).toBe("test@example.com");
        expect(json.sessions).toHaveLength(1);
        expect(json.sessions[0].shareUrl).toBe("http://share/1");
        expect(emitted).toHaveLength(0);
    });

    test("POST /oauth emits mcp_auth_paste_required", async () => {
        const emitted: unknown[] = [];
        const listeners = new Map<string, (data: unknown) => void>();
        const sessions: FakeSession[] = [
            {
                sessionId: "s1",
                token: "t1",
                shareUrl: "http://share/1",
                relay: {
                    emitEvent: (_sid, _token, event) => emitted.push(event),
                    emitSessionEnd: () => {},
                    socket: {
                        on: (event: string, cb: (data: unknown) => void) => listeners.set(event, cb),
                        off: (event: string, _cb: (data: unknown) => void) => listeners.delete(event),
                    },
                },
            },
        ];
        const scenario = {
            sessions,
            server: {
                baseUrl: "http://127.0.0.1:9999",
                userEmail: "test@example.com",
                apiKey: "key-123",
            },
            addSession: async () => { throw new Error("unused"); },
        } as any;

        const api = await startSandboxApi({
            scenario,
            scenarios: { demo: { name: "Demo", builder: () => [] } },
            models: [{ provider: "x", id: "m1", name: "Model 1", contextWindow: 1 }],
            cwds: ["/tmp"],
        });
        apis.push(api);

        const res = await fetch(`${api.baseUrl}/oauth`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session: 1, server: "figma" }),
        });
        expect(res.ok).toBe(true);
        const json = await res.json() as any;
        expect(json.serverName).toBe("figma");
        expect(typeof json.nonce).toBe("string");
        expect(emitted).toHaveLength(1);
        expect((emitted[0] as any).type).toBe("mcp_auth_paste_required");
        expect((emitted[0] as any).serverName).toBe("figma");

        // Simulate viewer pasting the callback URL → should emit auth_complete
        listeners.get("mcp_oauth_paste")?.({ nonce: json.nonce, code: "abc123" });
        expect(emitted).toHaveLength(2);
        expect((emitted[1] as any).type).toBe("mcp_auth_complete");
    });
});
