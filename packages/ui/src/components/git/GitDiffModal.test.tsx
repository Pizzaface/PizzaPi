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

mock.module("@/components/ui/dialog", () => ({
    Dialog: ({ open = true, children }: { open?: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children, showCloseButton: _showCloseButton, ...props }: React.HTMLAttributes<HTMLDivElement> & { showCloseButton?: boolean }) => <div role="dialog" {...props}>{children}</div>,
    DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props}>{children}</h2>,
    DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
    DialogClose: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
    DialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogOverlay: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DialogTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}>{children}</button>,
}));

mock.module("@/components/ui/scroll-area", () => ({
    ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

mock.module("@/components/ui/spinner", () => ({
    Spinner: () => <span data-testid="spinner" />,
}));

const { GitDiffModal } = await import("./GitDiffModal");

afterAll(() => mock.restore());

afterEach(() => cleanup());

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const changes = [
    { status: "MM", path: "src/app.ts" },
    { status: " M", path: "src/other.ts" },
];

describe("GitDiffModal", () => {
    test("shows staged and unstaged entries for a partially staged file", async () => {
        const fetchDiff = mock(async (_path: string, staged?: boolean) => (staged ? "staged diff" : "unstaged diff"));
        const view = render(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged
                fetchDiff={fetchDiff}
            />,
        );

        await waitFor(() => expect(view.getByText("staged diff")).toBeTruthy());
        expect(view.getByRole("button", { name: "View staged diff for src/app.ts" })).toBeTruthy();
        fireEvent.click(view.getByRole("button", { name: "View unstaged diff for src/app.ts" }));

        await waitFor(() => expect(fetchDiff).toHaveBeenLastCalledWith("src/app.ts", false));
        await waitFor(() => expect(view.getByText("unstaged diff")).toBeTruthy());
    });

    test("ignores stale diff responses after selecting another file", async () => {
        const first = deferred<string>();
        const fetchDiff = mock((path: string) => (path === "src/app.ts" ? first.promise : Promise.resolve("other diff")));
        const view = render(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged
                fetchDiff={fetchDiff}
            />,
        );

        fireEvent.click(view.getByRole("button", { name: "View unstaged diff for src/other.ts" }));
        await waitFor(() => expect(view.getByText("other diff")).toBeTruthy());

        first.resolve("late app diff");
        await new Promise((resolve) => queueMicrotask(resolve));

        expect(view.queryByText("late app diff")).toBeNull();
        expect(view.getByText("other diff")).toBeTruthy();
    });

    test("refreshKey refreshes the selected diff without changing selection", async () => {
        const fetchDiff = mock(async () => (fetchDiff.mock.calls.length === 1 ? "first diff" : "refreshed diff"));
        const view = render(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
                refreshKey={0}
            />,
        );

        await waitFor(() => expect(view.getByText("first diff")).toBeTruthy());
        view.rerender(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
                refreshKey={1}
            />,
        );

        await waitFor(() => expect(fetchDiff).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(view.getByText("refreshed diff")).toBeTruthy());
        expect(fetchDiff).toHaveBeenLastCalledWith("src/app.ts", false);
    });

    test("keeps the current diff visible while refreshing the same selection", async () => {
        const refresh = deferred<string>();
        const fetchDiff = mock(() => fetchDiff.mock.calls.length === 1 ? Promise.resolve("current diff") : refresh.promise);
        const props = { open: true, onOpenChange: () => {}, changes, initialPath: "src/app.ts", fetchDiff };
        const view = render(<GitDiffModal {...props} refreshKey={0} />);
        await waitFor(() => expect(view.getByText("current diff")).toBeTruthy());
        view.rerender(<GitDiffModal {...props} refreshKey={1} />);
        expect(view.getByText("current diff")).toBeTruthy();
        expect(view.queryByText("Loading diff…")).toBeNull();
        refresh.resolve("updated diff");
        await waitFor(() => expect(view.getByText("updated diff")).toBeTruthy());
    });

    test("clears the stale diff when all changes disappear", async () => {
        const fetchDiff = mock(async () => "app diff");
        const view = render(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
            />,
        );

        await waitFor(() => expect(view.getByText("app diff")).toBeTruthy());
        view.rerender(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={[]}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
            />,
        );

        await waitFor(() => expect(view.getByText("Select a file")).toBeTruthy());
        expect(view.queryByText("app diff")).toBeNull();
    });

    test("keeps selection when valid and falls back when the selected change disappears", async () => {
        const fetchDiff = mock(async (path: string) => `${path} diff`);
        const view = render(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={changes}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
            />,
        );

        fireEvent.click(view.getByRole("button", { name: "View unstaged diff for src/other.ts" }));
        await waitFor(() => expect(view.getByText("src/other.ts diff")).toBeTruthy());

        view.rerender(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={[{ status: " M", path: "src/other.ts" }, { status: " M", path: "src/new.ts" }]}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
            />,
        );
        await waitFor(() => expect(fetchDiff).toHaveBeenLastCalledWith("src/other.ts", false));

        view.rerender(
            <GitDiffModal
                open
                onOpenChange={() => {}}
                changes={[{ status: " M", path: "src/new.ts" }]}
                initialPath="src/app.ts"
                initialStaged={false}
                fetchDiff={fetchDiff}
            />,
        );
        await waitFor(() => expect(fetchDiff).toHaveBeenLastCalledWith("src/new.ts", false));
        await waitFor(() => expect(view.getByText("src/new.ts diff")).toBeTruthy());
    });
});
