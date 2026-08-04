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
const LOG = [
    { hash: A, shortHash: "aaaa111", author: "A", authorDate: "2026-06-25T10:00:00Z", commitDate: "2026-06-25T10:00:00Z", subject: "feat: newest", body: "", refs: ["HEAD -> main"], parents: [B] },
    { hash: B, shortHash: "bbbb222", author: "A", authorDate: "2026-06-24T10:00:00Z", commitDate: "2026-06-24T10:00:00Z", subject: "fix: older", body: "", refs: [], parents: [] },
];

function renderBody() {
    const fetchLog = mock(async () => LOG);
    const fetchCommitFiles = mock(async () => [{ status: "M", path: "src/a.ts" }]);
    const fetchDiffRevs = mock(async () => "diff");
    const onOpenChange = mock(() => {});
    const utils = render(
        <GitRevExplorerBody
            onOpenChange={onOpenChange}
            log={[]}
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
        await waitFor(() => expect(fetchDiffRevs).toHaveBeenCalledWith(A, A + "^"));
    });

    test("selecting a commit re-scopes the files pane", async () => {
        const { getByText, fetchCommitFiles } = renderBody();
        await waitFor(() => expect(getByText("fix: older")).toBeTruthy());
        fireEvent.click(getByText("fix: older"));
        await waitFor(() => expect(fetchCommitFiles).toHaveBeenCalledWith(B, undefined));
    });
});
