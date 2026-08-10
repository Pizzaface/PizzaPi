/**
 * Regression tests for subagent engine credential sharing.
 *
 * Isolated in its own file because it must mock.module the upstream
 * pi-coding-agent SDK; the project test runner invokes CLI tests per-file.
 */

import { describe, test, expect, mock } from "bun:test";

// Hermetic: the dev/CI machine may itself run under a PizzaPi worker with
// PIZZAPI_HIDDEN_MODELS set — that must not leak into these tests.
delete process.env.PIZZAPI_HIDDEN_MODELS;

const createAgentSessionCalls: unknown[] = [];
const fakeRuntime = Object.freeze({ id: "parent-runtime" });

mock.module("@earendil-works/pi-coding-agent", () => ({
    createAgentSession: mock(async (options: unknown) => {
        createAgentSessionCalls.push(options);
        return {
            session: {
                prompt: mock(async () => {}),
                subscribe: mock(() => mock(() => {})),
                abort: mock(async () => {}),
                dispose: mock(() => {}),
            },
        };
    }),
    DefaultResourceLoader: class {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_options: unknown) {}
        async reload() {}
    },
    createCodingTools: mock(() => [{ name: "read" }] as unknown[]),
    createReadOnlyTools: mock(() => [{ name: "read" }] as unknown[]),
}));

import { runSingleAgent } from "./engine.js";

const noopAgent = {
    name: "noop",
    description: "noop agent",
    tools: ["read"],
    systemPrompt: "",
    source: "user" as const,
    filePath: "noop.md",
};

describe("runSingleAgent model runtime reuse", () => {
    test("passes the parent's live ModelRuntime so OAuth/subscription providers work", async () => {
        const registry: any = {
            find: () => undefined,
            getAvailable: () => [],
            getApiKeyForProvider: mock(async () => "key"),
            runtime: fakeRuntime,
        };

        const result = await runSingleAgent(
            process.cwd(),
            [noopAgent],
            "noop",
            "task",
            undefined,
            undefined,
            undefined,
            undefined,
            (r) => ({ mode: "single", results: r }) as any,
            undefined,
            registry,
        );

        expect(result.exitCode).toBe(0);
        const options = createAgentSessionCalls[createAgentSessionCalls.length - 1] as any;
        expect(options.modelRuntime).toBe(fakeRuntime);
    });

    test("falls back to a fresh runtime when the registry has no runtime", async () => {
        const registry: any = {
            find: () => undefined,
            getAvailable: () => [],
            getApiKeyForProvider: mock(async () => "key"),
        };

        const result = await runSingleAgent(
            process.cwd(),
            [noopAgent],
            "noop",
            "task",
            undefined,
            undefined,
            undefined,
            undefined,
            (r) => ({ mode: "single", results: r }) as any,
            undefined,
            registry,
        );

        expect(result.exitCode).toBe(0);
        const options = createAgentSessionCalls[createAgentSessionCalls.length - 1] as any;
        expect(options.modelRuntime).toBeUndefined();
    });

    test("does not pass modelRuntime for a narrow test-only registry", async () => {
        const registry: any = {
            find: () => undefined,
            getAvailable: () => [],
        };

        const result = await runSingleAgent(
            process.cwd(),
            [noopAgent],
            "noop",
            "task",
            undefined,
            undefined,
            undefined,
            undefined,
            (r) => ({ mode: "single", results: r }) as any,
            undefined,
            registry,
        );

        expect(result.exitCode).toBe(0);
        const options = createAgentSessionCalls[createAgentSessionCalls.length - 1] as any;
        expect(options.modelRuntime).toBeUndefined();
    });
});
