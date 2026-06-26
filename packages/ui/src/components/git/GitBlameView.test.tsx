import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

mock.module("@/lib/utils", () => ({
    cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

mock.module("@/components/ui/spinner", () => ({
    Spinner: () => <div data-testid="spinner" />,
}));

mock.module("@/components/ui/badge", () => ({
    Badge: ({ children }: { children?: React.ReactNode }) => <span data-testid="badge">{children}</span>,
}));

const gitState = {
    available: true,
    blame: null as { lines: any[]; content: string[] } | null,
    fetchBlame: mock(async () => []),
    fetchDiffRevs: mock(async () => ""),
};

mock.module("@/hooks/useGitService", () => ({
    useGitService: () => gitState,
}));

const { GitBlameView } = await import("./GitBlameView");

afterAll(() => mock.restore());

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    gitState.blame = null;
    gitState.fetchBlame.mockClear();
    gitState.fetchDiffRevs.mockClear();
});

describe("GitBlameView", () => {
    test("fetches blame on mount", async () => {
        gitState.blame = { lines: [], content: [] };
        render(<GitBlameView cwd="/repo" path="readme.txt" />);

        await waitFor(() => expect(gitState.fetchBlame).toHaveBeenCalledWith("readme.txt", undefined));
    });

    test("shows loading state while blame is missing", () => {
        const { queryByTestId, queryByText } = render(<GitBlameView cwd="/repo" path="readme.txt" />);

        expect(queryByTestId("spinner")).toBeTruthy();
        expect(queryByText(/Loading blame/)).toBeTruthy();
    });

    test("renders grouped blame with line numbers and wrapped code", async () => {
        gitState.blame = {
            lines: [
                { hash: "abc1234", author: "Jordan", authorDate: new Date(Date.now() - 86400000).toISOString(), summary: "init" },
                { hash: "abc1234", author: "Jordan", authorDate: new Date(Date.now() - 86400000).toISOString(), summary: "init" },
                { hash: "def5678", author: "Alex", authorDate: new Date(Date.now() - 172800000).toISOString(), summary: "update" },
            ],
            content: ["# Quick Start", "npm install", "const x = 1;"],
        };

        const { queryByText } = render(<GitBlameView cwd="/repo" path="readme.txt" />);

        await waitFor(() => expect(queryByText("# Quick Start")).toBeTruthy());
        expect(queryByText("npm install")).toBeTruthy();
        expect(queryByText("const x = 1;")).toBeTruthy();
        expect(queryByText("abc1234")).toBeTruthy();
        expect(queryByText("def5678")).toBeTruthy();
        expect(queryByText("Jordan")).toBeTruthy();
        expect(queryByText("Alex")).toBeTruthy();
        expect(queryByText("1")).toBeTruthy();
        expect(queryByText("3")).toBeTruthy();
    });

    test("clicking a blame group fetches and displays the commit diff", async () => {
        gitState.blame = {
            lines: [
                { hash: "abc1234", author: "Jordan", authorDate: new Date().toISOString(), summary: "init" },
            ],
            content: ["hello"],
        };
        gitState.fetchDiffRevs = mock(async () =>
            [
                "diff --git a/readme.txt b/readme.txt",
                "index 0000000..abc1234 100644",
                "--- a/readme.txt",
                "+++ b/readme.txt",
                "@@ -0,0 +1 @@",
                "+hello",
            ].join("\n"),
        );

        const { queryByText, container } = render(<GitBlameView cwd="/repo" path="readme.txt" />);

        await waitFor(() => expect(queryByText("hello")).toBeTruthy());
        const gutterButton = container.querySelector("button[title*='init']");
        expect(gutterButton).toBeTruthy();

        fireEvent.click(gutterButton!);

        await waitFor(() => expect(gitState.fetchDiffRevs).toHaveBeenCalledWith("abc1234", "abc1234^", "readme.txt"));
        await waitFor(() => expect(queryByText("+hello")).toBeTruthy());
        expect(queryByText("readme.txt")).toBeTruthy();
    });

    test("shows revision badge when revision is provided", async () => {
        gitState.blame = { lines: [], content: [] };

        const { queryByTestId } = render(<GitBlameView cwd="/repo" path="readme.txt" revision="main" />);

        await waitFor(() => expect(queryByTestId("badge")?.textContent).toBe("main"));
    });
});
