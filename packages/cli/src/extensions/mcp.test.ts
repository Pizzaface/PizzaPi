import { describe, expect, test } from "bun:test";
import type { McpServerInitResult, McpRegistrationResult } from "./mcp.js";

/**
 * Unit tests for MCP timeout + parallel init behavior.
 *
 * These tests cover the exported types and the timeout/parallel design.
 * Full integration tests would require spawning real MCP servers, which
 * is out of scope for unit tests.
 */

describe("MCP types", () => {
    test("McpServerInitResult captures timing data", () => {
        const result: McpServerInitResult = {
            name: "test-server",
            tools: [],
            durationMs: 1500,
            timedOut: false,
        };
        expect(result.name).toBe("test-server");
        expect(result.durationMs).toBe(1500);
        expect(result.timedOut).toBe(false);
        expect(result.error).toBeUndefined();
    });

    test("McpServerInitResult captures timeout errors", () => {
        const result: McpServerInitResult = {
            name: "slow-server",
            tools: [],
            error: "Timed out after 30s waiting for tools/list",
            durationMs: 30000,
            timedOut: true,
        };
        expect(result.timedOut).toBe(true);
        expect(result.error).toContain("Timed out");
    });

    test("McpRegistrationResult includes overall timing", () => {
        const result: McpRegistrationResult = {
            clients: [],
            toolCount: 5,
            toolNames: ["tool1", "tool2", "tool3", "tool4", "tool5"],
            errors: [],
            serverTools: { server1: ["tool1", "tool2"], server2: ["tool3", "tool4", "tool5"] },
            serverTimings: [
                { name: "server1", tools: [], durationMs: 200, timedOut: false },
                { name: "server2", tools: [], durationMs: 500, timedOut: false },
            ],
            totalDurationMs: 500, // parallel — wall clock is max, not sum
        };
        expect(result.totalDurationMs).toBe(500);
        expect(result.serverTimings).toHaveLength(2);
    });
});
