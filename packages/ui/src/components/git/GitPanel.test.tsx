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
    lastOperationResult: null as any,
    lastConflictType: null as string | null,
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
    mergeAbort: mock(() => {}),
    rebase: mock(() => {}),
    rebaseAbort: mock(() => {}),
    rebaseContinue: mock(() => {}),
    addWorktree: mock(() => {}),
    removeWorktree: mock(() => {}),
    clearOperationResult: mock(() => {}),
    // New git-UX methods/state
    stashes: [] as any[],
    log: [] as any[],
    blame: null,
    stashList: mock(() => {}),
    stashPush: mock(() => {}),
    stashPop: mock(() => {}),
    stashApply: mock(() => {}),
    stashDrop: mock(() => {}),
    fetchLog: mock(async () => []),
    fetchDiffRevs: mock(async () => ""),
    fetchBlame: mock(async () => []),
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

mock.module("@/components/ui/tooltip", () => ({
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

mock.module("./GitStashList", () => ({
    GitStashList: () => <div data-testid="stash-list" />,
}));

mock.module("./GitHistoryView", () => ({
    GitHistoryView: () => <div data-testid="history-view" />,
}));

mock.module("./GitDiffRevsView", () => ({
    GitDiffRevsView: () => <div data-testid="diff-revs-view" />,
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

    test("shows rebase conflict resolution bar when last operation returned a conflict", () => {
        gitState.operationInProgress = null;
        gitState.lastOperationResult = { ok: false, reason: "conflict", message: "Conflicts" };

        const { getByText } = render(<GitPanel cwd="/repo" />);

        expect(getByText("Conflicts detected. Resolve them to continue.")).toBeTruthy();
        expect(getByText("Continue")).toBeTruthy();
        expect(getByText("Abort")).toBeTruthy();
    });

    test("shows stash conflict banner (no abort/continue) when stash apply conflicts", () => {
        gitState.operationInProgress = null;
        gitState.lastConflictType = "git_stash_result";
        gitState.lastOperationResult = { ok: true, conflict: true, message: "CONFLICT" };

        const { getByText, queryByText } = render(<GitPanel cwd="/repo" />);

        expect(getByText(/Stash apply hit conflicts/)).toBeTruthy();
        // Stash conflicts have no abort/continue — those belong to merge/rebase only.
        expect(queryByText("Continue")).toBeNull();
        expect(queryByText("Abort")).toBeNull();
        expect(queryByText("Abort Merge")).toBeNull();

        // reset for afterEach
        gitState.lastConflictType = null;
    });

    test("re-fetches last-commit log when current branch shortHash changes", () => {
        gitState.status.branch = "feature/test";
        gitState.branches = [
            { name: "feature/test", shortHash: "abc1234", lastCommit: "2 hours ago", isCurrent: true, isRemote: false },
        ];
        gitState.log = [];
        const callsBefore = gitState.fetchLog.mock.calls.length;

        const { rerender } = render(<GitPanel cwd="/repo" />);
        expect(gitState.fetchLog.mock.calls.length).toBeGreaterThan(callsBefore);

        const callsAfterInitial = gitState.fetchLog.mock.calls.length;

        gitState.branches = [
            { name: "feature/test", shortHash: "def5678", lastCommit: "1 hour ago", isCurrent: true, isRemote: false },
        ];
        rerender(<GitPanel cwd="/repo" />);
        expect(gitState.fetchLog.mock.calls.length).toBe(callsAfterInitial + 1);
    });

    test("falls back to hash+date tooltip when log entry is stale relative to HEAD", () => {
        gitState.status.branch = "feature/test";
        gitState.branches = [
            { name: "feature/test", shortHash: "newhash", lastCommit: "5 min ago", isCurrent: true, isRemote: false },
        ];
        gitState.log = [
            {
                hash: "oldhasholdhasholdhasholdhasholdhasholdhash",
                shortHash: "oldhash",
                author: "Dev",
                authorDate: "2026-07-05T10:00:00Z",
                commitDate: "2026-07-05T10:00:00Z",
                subject: "Old subject",
                body: "",
                refs: ["HEAD", "feature/test"],
            },
        ];

        const { rerender, getByText } = render(<GitPanel cwd="/repo" />);
        expect(getByText("newhash · 5 min ago")).toBeTruthy();

        gitState.log = [
            {
                hash: "newhashhashhashhashhashhashhashhashhashhas",
                shortHash: "newhash",
                author: "Dev",
                authorDate: "2026-07-09T10:00:00Z",
                commitDate: "2026-07-09T10:00:00Z",
                subject: "New subject",
                body: "",
                refs: ["HEAD", "feature/test"],
            },
        ];
        rerender(<GitPanel cwd="/repo" />);
        expect(getByText("newhash New subject")).toBeTruthy();
    });
});
