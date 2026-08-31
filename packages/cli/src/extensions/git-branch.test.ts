import { describe, test, expect, mock } from "bun:test";

let runGitCalls = 0;
let stubBranch: string | undefined = "feat/test-branch";

// Stub the git helper so tests are hermetic and we can count lookups.
mock.module("../config/system-prompt.js", () => ({
    runGit: () => {
        runGitCalls++;
        return stubBranch;
    },
}));

const { gitBranchExtension, injectGitBranch } = await import("./git-branch.js");

function mockPi(cwd: string) {
    const handlers: Record<string, (arg: any) => any> = {};
    return {
        cwd,
        on: (event: string, handler: any) => {
            handlers[event] = handler;
        },
        fire: (event: string, arg: any) => handlers[event](arg),
    };
}

describe("injectGitBranch", () => {
    test("inserts the branch line above Working directory", () => {
        const prompt = "Meta\nWorking directory: /repo\n\nrules";
        expect(injectGitBranch(prompt, "main", "/repo")).toBe(
            "Meta\nGit branch: main\nWorking directory: /repo\n\nrules",
        );
    });

    test("appends the branch line when the anchor is missing", () => {
        expect(injectGitBranch("prompt", "main", "/elsewhere")).toBe("prompt\nGit branch: main");
    });
});

describe("gitBranchExtension", () => {
    test("computes the branch once and injects it on every turn", () => {
        stubBranch = "feat/test-branch";
        const pi = mockPi("/repo");
        gitBranchExtension(pi as any);
        const turn = () => pi.fire("before_agent_start", { systemPrompt: "Working directory: /repo", systemPromptOptions: { cwd: "/repo" } });

        const first = turn();
        expect(first?.systemPrompt).toContain("Git branch: feat/test-branch");
        const second = turn();
        expect(second?.systemPrompt).toBe(first?.systemPrompt);
        expect(runGitCalls).toBe(1); // looked up once, not per turn
    });

    test("recomputes after a session switch", () => {
        stubBranch = "other-branch";
        const pi = mockPi("/repo");
        gitBranchExtension(pi as any);
        pi.fire("before_agent_start", { systemPrompt: "Working directory: /repo", systemPromptOptions: { cwd: "/repo" } });
        pi.fire("session_start", {});
        const result = pi.fire("before_agent_start", { systemPrompt: "Working directory: /repo", systemPromptOptions: { cwd: "/repo" } });
        expect(result?.systemPrompt).toContain("Git branch: other-branch");
    });

    test("does not inject outside a git repo", () => {
        stubBranch = undefined;
        const pi = mockPi("/not/a/repo");
        gitBranchExtension(pi as any);
        const result = pi.fire("before_agent_start", { systemPrompt: "Working directory: /not/a/repo", systemPromptOptions: { cwd: "/not/a/repo" } });
        expect(result?.systemPrompt).toBeUndefined();
    });
});