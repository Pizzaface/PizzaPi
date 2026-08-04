import { describe, test, expect, afterEach, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
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
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// The dialog pulls in Radix Dialog/Select (portal-heavy); stub it for this test.
mock.module("./GitAddWorktreeDialog", () => ({
    GitAddWorktreeDialog: () => <div data-testid="add-worktree-dialog" />,
}));

const { GitWorktreeList } = await import("./GitWorktreeList");

afterEach(() => cleanup());

const WORKTREES = [
    { path: "/repo", displayPath: ".", branch: "main", shortHash: "aaaaaaa", isDetached: false, isMain: true, changeCount: 0, ahead: 0, behind: 0 },
    { path: "/repo/.worktrees/feat", displayPath: ".worktrees/feat", branch: "feat/x", shortHash: "bbbbbbb", isDetached: false, isMain: false, changeCount: 2, ahead: 1, behind: 0 },
];

function renderList(overrides?: any) {
    const onPrune = mock(() => {});
    const utils = render(
        <GitWorktreeList
            worktrees={WORKTREES}
            branches={[]}
            currentBranch="main"
            onOpen={() => {}}
            onOpenBranches={() => {}}
            onAdd={() => {}}
            onRemove={() => {}}
            onPrune={onPrune}
            operationInProgress={null}
            {...overrides}
        />,
    );
    return { ...utils, onPrune };
}

describe("GitWorktreeList", () => {
    test("expands to show worktree rows", () => {
        const { getByText, queryByText } = renderList();
        // Collapsed header shows the count; rows appear after expanding.
        expect(queryByText("feat/x")).toBeNull();
        fireEvent.click(getByText("Worktrees"));
        expect(getByText("feat/x")).toBeTruthy();
        expect(getByText("main worktree")).toBeTruthy();
    });

    test("prune button calls onPrune", () => {
        const { getByText, onPrune } = renderList();
        fireEvent.click(getByText("Worktrees"));
        fireEvent.click(getByText("Prune stale worktrees"));
        expect(onPrune).toHaveBeenCalled();
    });
});
