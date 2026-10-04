import { describe, test, expect, afterEach, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { GitRevExplorerBody } from "./GitRevExplorer";

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

afterEach(() => cleanup());

const A = "aaaa1111".repeat(4);
const B = "bbbb2222".repeat(4);
const C = "cccc3333".repeat(4);
const LOG = [
    { hash: A, shortHash: "aaaa111", author: "A", authorDate: "2026-06-25T10:00:00Z", commitDate: "2026-06-25T10:00:00Z", subject: "feat: newest", body: "", refs: ["HEAD -> main"], parents: [B] },
    { hash: B, shortHash: "bbbb222", author: "A", authorDate: "2026-06-24T10:00:00Z", commitDate: "2026-06-24T10:00:00Z", subject: "fix: older", body: "", refs: [], parents: [] },
];
const UPDATED_LOG = [
    { hash: C, shortHash: "cccc333", author: "A", authorDate: "2026-06-26T10:00:00Z", commitDate: "2026-06-26T10:00:00Z", subject: "feat: refreshed", body: "", refs: ["HEAD -> main"], parents: [A] },
    { ...LOG[0], refs: [] },
    LOG[1],
];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function renderBody(props: Partial<React.ComponentProps<typeof GitRevExplorerBody>> = {}) {
    const fetchLog = props.fetchLog ?? mock(async () => LOG);
    const fetchCommitFiles = props.fetchCommitFiles ?? mock(async () => [{ status: "M", path: "src/a.ts" }]);
    const fetchDiffRevs = props.fetchDiffRevs ?? mock(async () => "diff");
    const onOpenChange = props.onOpenChange ?? mock(() => {});
    const utils = render(
        <GitRevExplorerBody
            onOpenChange={onOpenChange}
            log={props.log ?? []}
            refreshKey={props.refreshKey}
            fetchLog={fetchLog}
            fetchCommitFiles={fetchCommitFiles}
            fetchDiffRevs={fetchDiffRevs}
        />,
    );
    return { ...utils, fetchLog, fetchCommitFiles, fetchDiffRevs };
}

describe("GitRevExplorerBody", () => {
    test("loads the log and renders commit subjects", async () => {
        const { getByText, fetchLog } = renderBody();
        await waitFor(() => expect(fetchLog).toHaveBeenCalled());
        await waitFor(() => expect(getByText("feat: newest")).toBeTruthy());
        await waitFor(() => expect(getByText("fix: older")).toBeTruthy());
    });

    test("fetches files + diff for the head commit on mount", async () => {
        const { fetchCommitFiles, fetchDiffRevs } = renderBody();
        await waitFor(() => expect(fetchCommitFiles).toHaveBeenCalledWith(A, undefined));
        await waitFor(() => expect(fetchDiffRevs).toHaveBeenCalledWith(A + "^", A, undefined));
    });

    test("selecting a commit re-scopes the files pane", async () => {
        const { getByText, fetchCommitFiles } = renderBody();
        await waitFor(() => expect(getByText("fix: older")).toBeTruthy());
        fireEvent.click(getByText("fix: older"));
        await waitFor(() => expect(fetchCommitFiles).toHaveBeenCalledWith(B, undefined));
    });

    test("clicking a file scopes the diff to that path", async () => {
        const { getByText, fetchDiffRevs } = renderBody();
        await waitFor(() => expect(getByText("a.ts")).toBeTruthy());
        fireEvent.click(getByText("a.ts"));
        await waitFor(() => expect(fetchDiffRevs).toHaveBeenCalledWith(A + "^", A, "src/a.ts"));
    });

    test("refreshKey reloads history without losing a still-present selected commit", async () => {
        const fetchLog = mock(async () => LOG);
        const { getByText, queryByText, rerender, fetchCommitFiles, fetchDiffRevs } = renderBody({ fetchLog, refreshKey: "main:old" });

        await waitFor(() => expect(getByText("fix: older")).toBeTruthy());
        fireEvent.click(getByText("fix: older"));
        await waitFor(() => expect(fetchCommitFiles).toHaveBeenCalledWith(B, undefined));

        fetchLog.mockImplementation(async () => UPDATED_LOG);
        rerender(
            <GitRevExplorerBody
                onOpenChange={mock(() => {})}
                log={[]}
                refreshKey="main:new"
                fetchLog={fetchLog}
                fetchCommitFiles={fetchCommitFiles}
                fetchDiffRevs={fetchDiffRevs}
            />,
        );

        await waitFor(() => expect(getByText("feat: refreshed")).toBeTruthy());
        expect(queryByText("No commits found")).toBeNull();
        await waitFor(() => expect(fetchDiffRevs).toHaveBeenLastCalledWith(B + "^", B, undefined));
    });

    test("ignores a stale history response after a newer refresh wins", async () => {
        const slow = deferred<typeof LOG>();
        const fast = deferred<typeof UPDATED_LOG>();
        const fetchLog = mock(() => slow.promise as Promise<typeof LOG> | Promise<typeof UPDATED_LOG>);
        const { getByText, queryByText, rerender } = renderBody({ fetchLog, refreshKey: 0 });

        fetchLog.mockImplementationOnce(() => fast.promise);
        rerender(
            <GitRevExplorerBody
                onOpenChange={mock(() => {})}
                log={[]}
                refreshKey={1}
                fetchLog={fetchLog}
                fetchCommitFiles={mock(async () => [{ status: "M", path: "src/a.ts" }])}
                fetchDiffRevs={mock(async () => "diff")}
            />,
        );

        fast.resolve(UPDATED_LOG);
        await waitFor(() => expect(getByText("feat: refreshed")).toBeTruthy());
        slow.resolve([] as unknown as typeof LOG);
        await waitFor(() => expect(queryByText("No commits found")).toBeNull());
        expect(getByText("feat: refreshed")).toBeTruthy();
    });

    test("shows a retryable history error instead of an empty state", async () => {
        const originalError = console.error;
        console.error = mock(() => {}) as typeof console.error;
        try {
            const fetchLog = mock(async () => { throw new Error("boom"); });
            const { getByText, queryByText } = renderBody({ fetchLog });

            await waitFor(() => expect(getByText("Failed to load history.")).toBeTruthy());
            expect(queryByText("No commits found")).toBeNull();

            fetchLog.mockImplementation(async () => LOG);
            fireEvent.click(getByText("Retry"));
            await waitFor(() => expect(getByText("feat: newest")).toBeTruthy());
        } finally {
            console.error = originalError;
        }
    });

    test("keeps cached history visible when refresh fails", async () => {
        const originalError = console.error;
        console.error = mock(() => {}) as typeof console.error;
        try {
            const fetchLog = mock(async () => { throw new Error("offline"); });
            const { getByText, queryByText } = renderBody({ log: LOG, fetchLog });

            expect(getByText("feat: newest")).toBeTruthy();
            await waitFor(() => expect(getByText("Retry")).toBeTruthy());
            expect(getByText("feat: newest")).toBeTruthy();
            expect(queryByText("No commits found")).toBeNull();
        } finally {
            console.error = originalError;
        }
    });

    test("clears stale file list while loading another commit's files", async () => {
        const nextFiles = deferred<Array<{ status: string; path: string }>>();
        const fetchCommitFiles = mock((revision: string) => revision === A
            ? Promise.resolve([{ status: "M", path: "src/a.ts" }])
            : nextFiles.promise);
        const { getByText, queryByText } = renderBody({ fetchCommitFiles });

        await waitFor(() => expect(getByText("a.ts")).toBeTruthy());
        fireEvent.click(getByText("fix: older"));
        await waitFor(() => expect(queryByText("a.ts")).toBeNull());

        nextFiles.resolve([{ status: "M", path: "src/b.ts" }]);
        await waitFor(() => expect(getByText("b.ts")).toBeTruthy());
    });

    test("shows commit-file load errors instead of masking them as empty commits", async () => {
        const originalError = console.error;
        console.error = mock(() => {}) as typeof console.error;
        try {
            const fetchCommitFiles = mock(async () => { throw new Error("bad revision"); });
            const { getByText, queryByText } = renderBody({ fetchCommitFiles });

            await waitFor(() => expect(getByText("Failed to load files.")).toBeTruthy());
            expect(queryByText("No files changed")).toBeNull();
        } finally {
            console.error = originalError;
        }
    });

    test("does not reload history when only callback identities change", async () => {
        const fetchLog = mock(async () => LOG);
        const { rerender } = renderBody({ fetchLog, refreshKey: "refs" });
        await waitFor(() => expect(fetchLog).toHaveBeenCalledTimes(1));

        rerender(
            <GitRevExplorerBody
                onOpenChange={mock(() => {})}
                log={[]}
                refreshKey="refs"
                fetchLog={mock(async () => UPDATED_LOG)}
                fetchCommitFiles={mock(async () => [{ status: "M", path: "src/a.ts" }])}
                fetchDiffRevs={mock(async () => "diff")}
            />,
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchLog).toHaveBeenCalledTimes(1);
    });
});
