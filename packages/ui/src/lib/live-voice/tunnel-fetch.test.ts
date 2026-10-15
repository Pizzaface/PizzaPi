import { describe, expect, test } from "bun:test";
import { fetchTunnelWithFallback } from "./tunnel-fetch";

describe("fetchTunnelWithFallback", () => {
    test("retries against the signed relay path when the isolated host is unreachable", async () => {
        const calls: string[] = [];
        const primary = new URL("https://isolated-runner.example/api/warm");
        const fallback = new URL("https://relay.example/api/tunnel/auth/token/runner/8123/api/warm");
        const response = await fetchTunnelWithFallback(primary, fallback, undefined, async (url) => {
            calls.push(url.toString());
            if (url.origin === primary.origin) throw new TypeError("Failed to fetch");
            return new Response("ok");
        });

        expect(calls).toEqual([primary.toString(), fallback.toString()]);
        expect(await response.text()).toBe("ok");
    });

    test("does not retry HTTP errors; they are real service responses", async () => {
        const calls: string[] = [];
        const response = await fetchTunnelWithFallback(
            new URL("https://isolated-runner.example/api/status"),
            new URL("https://relay.example/api/tunnel/auth/token/runner/8123/api/status"),
            undefined,
            async (url) => {
                calls.push(url.toString());
                return new Response("unavailable", { status: 503 });
            },
        );
        expect(response.status).toBe(503);
        expect(calls).toHaveLength(1);
    });
});
