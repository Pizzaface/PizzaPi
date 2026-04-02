import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).SyntaxError = SyntaxError;
(win as any).SyntaxError = SyntaxError;
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const gitState = {
    available: true,
    status: {
        branch: "feature/test",
        changes: [],
        ahead: 1,
        behind: 1,
        hasUpstream: true,
        diffStaged: "",
    },
    branches: [],
    branchesState: { loading: false, error: null, partial: false },
    worktrees: [],
    currentBranch: "feature/test",
    loading: false,
    error: null,
    operationInProgress: null as string | null,
    lastOperationResult: null,
    fetchStatus: mock(() => {}),
    fetchWorktrees: mock(() => {}),
    fetchDiff: mock(async () => ""),
    fetchBranches: mock(() => {}),
    checkout: mock(() => {}),
    stage: mock(() => {}),
    stageAll: mock(() => {}),
    unstage: mock(() => {}),
    unstageAll: mock(() => {}),
    commit: mock(() => {}),
    push: mock(() => {}),
    pull: mock(() => {}),
    setUpstream: mock(() => {}),
    merge: mock(() => {}),
    clearOperationResult: mock(() => {}),
};

mock.module("@/lib/utils", () => ({
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

mock.module("@/components/ui/spinner", () => ({
    Spinner: () => <div data-testid="spinner" />,
}));

mock.module("@/components/ui/button", () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button type="button" {...props}>{children}</button>
    ),
}));

mock.module("@/hooks/useGitService", () => ({
    useGitService: () => gitState,
}));

mock.module("./GitBranchSelector", () => ({
    GitBranchSelector: ({ disabled }: { disabled?: boolean }) => (
        <button type="button" data-testid="branch-selector" data-disabled={String(Boolean(disabled))}>
            branch
        </button>
    ),
}));

mock.module("./GitStagingArea", () => ({
    partitionChanges: () => ({ staged: [], unstaged: [] }),
    GitStagingArea: () => <div data-testid="staging-area" />,
}));

mock.module("./GitCommitForm", () => ({
    GitCommitForm: () => <div data-testid="commit-form" />,
}));

mock.module("./GitDiffView", () => ({
    GitDiffView: () => <div data-testid="diff-view" />,
}));

mock.module("./GitWorktreeList", () => ({
    GitWorktreeList: () => <div data-testid="worktree-list" />,
}));

afterAll(() => mock.restore());

const { GitPanel } = await import("./GitPanel");

afterEach(() => {
    cleanup();
    gitState.operationInProgress = null;
    gitState.status.changes = [];
    document.body.innerHTML = "";
});

describe("GitPanel", () => {
    test("disables branch selector and sync controls while any mutation is running", () => {
        gitState.operationInProgress = "commit";

        const { getByTestId, getByText } = render(<GitPanel cwd="/repo" />);

        expect(getByTestId("branch-selector").getAttribute("data-disabled")).toBe("true");
        expect((getByText("Pull").closest("button") as HTMLButtonElement).disabled).toBe(true);
        expect((getByText("Push").closest("button") as HTMLButtonElement).disabled).toBe(true);
        expect((getByText("Sync").closest("button") as HTMLButtonElement).disabled).toBe(true);
    });
});
