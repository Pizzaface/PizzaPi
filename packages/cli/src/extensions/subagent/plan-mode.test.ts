/**
 * Plan-mode propagation into subagent sessions.
 *
 * The integration tests here run the REAL subagent engine (`runSingleAgent`)
 * against a REAL pi `createAgentSession`, driven by pi-ai's faux provider.
 * The faux model tries to write/edit/mutate on its very first turn — that is
 * the boundary that matters: a plan-mode child must be read-only from turn
 * one, not after some later refresh.
 *
 * Isolated in its own file because it must mock.module the config module
 * (to keep the child's session files out of ~/.pizzapi); the project test
 * runner invokes CLI tests per-file.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: the dev/CI machine may itself run under a PizzaPi worker.
delete process.env.PIZZAPI_HIDDEN_MODELS;

const tmpRoot = mkdtempSync(join(tmpdir(), "pizzapi-subagent-plan-mode-"));
const agentDir = join(tmpRoot, "agent");
const workDir = join(tmpRoot, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const realConfig = await import("../../config.js");
mock.module("../../config.js", () => ({ ...realConfig, defaultAgentDir: () => agentDir }));

const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { runSingleAgent } = await import("./engine.js");
const { resolvePlanModeTools, PLAN_MODE_SUBAGENT_TOOLS, PLAN_MODE_SUBAGENT_PROMPT, planModeBashBlockedMessage } = await import("./plan-mode.js");

type Faux = ReturnType<typeof fauxProvider>;

let faux: Faux;
let registry: {
    find: (provider: string, id: string) => any;
    getAvailable: () => any[];
    getApiKeyForProvider: () => Promise<undefined>;
    runtime: unknown;
};

beforeAll(async () => {
    faux = fauxProvider({ provider: "faux-plan-test" });
    const runtime = await ModelRuntime.create({
        authPath: join(tmpRoot, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    // Shape of a real ModelRegistry as far as the engine cares: it hands
    // `runtime` to createAgentSession when getApiKeyForProvider exists.
    registry = {
        find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
        getAvailable: () => [model],
        getApiKeyForProvider: async () => undefined,
        runtime,
    };
});

afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});

const writerAgent = {
    name: "writer",
    description: "An agent that would normally have full write access",
    systemPrompt: "You are a helpful agent.",
    source: "user" as const,
    filePath: "writer.md",
};

interface ToolResultLike {
    role: string;
    toolName?: string;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
}

function toolResults(messages: unknown[]): ToolResultLike[] {
    return (messages as ToolResultLike[]).filter((m) => m.role === "toolResult");
}

function textOf(r: ToolResultLike): string {
    return (r.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Script: turn 1 attempts every kind of write; turn 2 finishes. Captures what the model saw. */
function scriptWriteAttempt(target: string) {
    const seen: { systemAndTools: string[] } = { systemAndTools: [] };
    faux.setResponses([
        (context) => {
            seen.systemAndTools.push(JSON.stringify(context));
            return fauxAssistantMessage(
                [
                    fauxToolCall("write", { path: join(target, "written.txt"), content: "pwned" }),
                    fauxToolCall("edit", { path: join(target, "existing.txt"), edits: [{ oldText: "original", newText: "edited" }] }),
                    fauxToolCall("bash", { command: `touch ${join(target, "touched.txt")}` }),
                    fauxToolCall("bash", { command: `echo pwned > ${join(target, "redirected.txt")}` }),
                    fauxToolCall("bash", { command: `ls ${target}` }),
                ],
                { stopReason: "toolUse" },
            );
        },
        fauxAssistantMessage([fauxText("done")]),
    ]);
    return seen;
}

function freshTarget(name: string): string {
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "existing.txt"), "original");
    return dir;
}

async function run(target: string, planMode: boolean | undefined, agent: Record<string, unknown> = writerAgent) {
    const model = faux.getModel();
    return runSingleAgent(
        target,
        [agent as any],
        agent.name as string,
        "Make some changes",
        undefined,
        undefined,
        undefined,
        undefined,
        (r) => ({ mode: "single", results: r }) as any,
        { provider: model.provider, id: model.id },
        registry as any,
        false, // no relay mirror
        undefined,
        undefined,
        planMode === undefined ? undefined : { planMode },
    );
}

describe("subagent plan-mode propagation (real AgentSession, first turn)", () => {
    test("control: without plan mode the same script does write files", async () => {
        const target = freshTarget("control");
        scriptWriteAttempt(target);
        const result = await run(target, false);

        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(target, "written.txt"), "utf-8")).toBe("pwned");
        expect(readFileSync(join(target, "existing.txt"), "utf-8")).toBe("edited");
        expect(existsSync(join(target, "touched.txt"))).toBe(true);
    });

    test("planMode: turn-one write/edit/mutating bash are all refused; read-only bash still works", async () => {
        const target = freshTarget("plan");
        const seen = scriptWriteAttempt(target);
        const result = await run(target, true);

        expect(result.exitCode).toBe(0);
        // Nothing on disk changed.
        expect(existsSync(join(target, "written.txt"))).toBe(false);
        expect(readFileSync(join(target, "existing.txt"), "utf-8")).toBe("original");
        expect(existsSync(join(target, "touched.txt"))).toBe(false);
        expect(existsSync(join(target, "redirected.txt"))).toBe(false);

        // The very first request already carried the restricted loadout + notice.
        expect(seen.systemAndTools).toHaveLength(1);
        const firstRequest = seen.systemAndTools[0];
        expect(firstRequest).toContain("PLAN MODE — READ-ONLY SUBAGENT");
        expect(firstRequest).toMatch(/"name":"read"/);
        expect(firstRequest).toMatch(/"name":"bash"/);
        expect(firstRequest).not.toMatch(/"name":"write"/);
        expect(firstRequest).not.toMatch(/"name":"edit"/);

        // The engine records tool results from both message_end and turn_end;
        // dedupe by identity and keep turn one's five results in call order.
        const results = [...new Set(toolResults(result.messages))];
        expect(results).toHaveLength(5);
        const [write, edit, touch, redirect, ls] = results;
        expect(write.isError).toBe(true);
        expect(edit.isError).toBe(true);
        expect(touch.isError).toBe(true);
        expect(textOf(touch)).toContain("Plan mode: command blocked");
        expect(redirect.isError).toBe(true);
        expect(textOf(redirect)).toContain("Plan mode: command blocked");
        expect(ls.isError).toBeFalsy();
        expect(textOf(ls)).toContain("existing.txt");
    });

    test("agent frontmatter permissionMode: plan uses the same enforcement", async () => {
        const target = freshTarget("frontmatter");
        scriptWriteAttempt(target);
        const result = await run(target, undefined, { ...writerAgent, name: "planner", permissionMode: "plan" });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(target, "written.txt"))).toBe(false);
        expect(readFileSync(join(target, "existing.txt"), "utf-8")).toBe("original");
        expect(existsSync(join(target, "touched.txt"))).toBe(false);
    });

    test("an agent that explicitly lists write tools still cannot use them in plan mode", async () => {
        const target = freshTarget("explicit-tools");
        scriptWriteAttempt(target);
        const result = await run(target, true, { ...writerAgent, tools: ["read", "write", "edit", "bash"] });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(target, "written.txt"))).toBe(false);
        expect(readFileSync(join(target, "existing.txt"), "utf-8")).toBe("original");
        expect(existsSync(join(target, "touched.txt"))).toBe(false);
    });
});

describe("resolvePlanModeTools", () => {
    test("unrestricted agent gets the full plan-mode set", () => {
        expect(resolvePlanModeTools(undefined)).toEqual([...PLAN_MODE_SUBAGENT_TOOLS]);
    });

    test("strips write tools and unknown names from an explicit list", () => {
        expect(resolvePlanModeTools(["read", "write", "edit", "bash", "mystery"])).toEqual(["read", "bash"]);
    });

    test("never widens a narrower explicit list", () => {
        expect(resolvePlanModeTools(["grep"])).toEqual(["grep"]);
    });

    test("falls back to read when nothing plan-safe was requested", () => {
        expect(resolvePlanModeTools(["write", "edit"])).toEqual(["read"]);
    });
});

describe("plan-mode subagent text", () => {
    test("prompt names the restriction", () => {
        expect(PLAN_MODE_SUBAGENT_PROMPT).toContain("read-only");
    });

    test("blocked message includes the command", () => {
        expect(planModeBashBlockedMessage("rm -rf /")).toContain("rm -rf /");
    });
});
