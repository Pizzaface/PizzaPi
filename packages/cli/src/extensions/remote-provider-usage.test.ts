import { describe, test, expect, mock } from "bun:test";
import { activeUsageWindows, refreshUsageViaRunner, buildProviderUsage, setUsageCachePreserving } from "./remote-provider-usage.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");

describe("activeUsageWindows", () => {
    test("drops windows whose reset time has passed", () => {
        const result = activeUsageWindows(
            [
                { label: "5-hour", utilization: 90, resets_at: "2026-03-10T07:00:00Z" },
                { label: "7-day", utilization: 20, resets_at: "2026-03-14T00:00:00Z" },
            ],
            NOW,
        );
        expect(result.map((w) => w.label)).toEqual(["7-day"]);
    });

    test("keeps a window that resets exactly now-ish but in the future", () => {
        const result = activeUsageWindows(
            [{ label: "5-hour", utilization: 90, resets_at: new Date(NOW + 1).toISOString() }],
            NOW,
        );
        expect(result).toHaveLength(1);
    });

    test("keeps windows with an unparseable reset time", () => {
        const result = activeUsageWindows([{ label: "7-day", utilization: 50, resets_at: "whenever" }], NOW);
        expect(result).toHaveLength(1);
    });

    test("returns an empty list when everything has expired", () => {
        const result = activeUsageWindows(
            [{ label: "5-hour", utilization: 99, resets_at: "2026-03-01T00:00:00Z" }],
            NOW,
        );
        expect(result).toEqual([]);
    });
});

describe("refreshUsageViaRunner", () => {
    test("updates in-memory cache from daemon IPC response", async () => {
        process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH = "/tmp/test-usage-cache.json";

        const send = mock((_: unknown) => true);
        const listeners: Array<(msg: unknown) => void> = [];
        const originalSend = process.send;
        const originalAddListener = process.addListener.bind(process);
        const originalRemoveListener = process.removeListener.bind(process);

        process.send = send as any;
        process.addListener = ((event: string, handler: (msg: unknown) => void) => {
            if (event === "message") listeners.push(handler);
            return process;
        }) as any;
        process.removeListener = ((event: string, handler: (msg: unknown) => void) => {
            if (event === "message") {
                const idx = listeners.indexOf(handler);
                if (idx >= 0) listeners.splice(idx, 1);
            }
            return process;
        }) as any;

        try {
            const promise = refreshUsageViaRunner({ force: true });

            expect(send).toHaveBeenCalled();
            const request = send.mock.calls[0][0] as { type: string; requestId: string };
            expect(request.type).toBe("refresh_usage_request");

            for (const listener of listeners) {
                listener({
                    type: "refresh_usage_response",
                    requestId: request.requestId,
                    fetchedAt: NOW,
                    providers: {
                        anthropic: {
                            windows: [{ label: "5-hour", utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() }],
                            status: "ok",
                        },
                    },
                });
            }

            await promise;
            const usage = buildProviderUsage();
            expect(usage.anthropic?.windows).toEqual([
                { label: "5-hour", utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() },
            ]);
        } finally {
            process.send = originalSend;
            process.addListener = originalAddListener as any;
            process.removeListener = originalRemoveListener as any;
            delete process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH;
        }
    });

    test("preserves existing windows on auth errors", () => {
        setUsageCachePreserving("anthropic", {
            windows: [{ label: "5-hour", utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() }],
            status: "ok",
        });
        setUsageCachePreserving("anthropic", { windows: [], status: "unknown", errorCode: 403 });
        const usage = buildProviderUsage();
        expect(usage.anthropic?.windows).toHaveLength(1);
        expect(usage.anthropic?.errorCode).toBe(403);
    });
});
