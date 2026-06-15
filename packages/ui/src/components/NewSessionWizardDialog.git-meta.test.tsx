import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

// Set up DOM globals BEFORE importing the component.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
// happy-dom's Window does not expose built-in error constructors, but Radix's
// remove-scroll-bar and other libs rely on them.
win.SyntaxError = SyntaxError;
win.TypeError = TypeError;
win.Error = Error;
(globalThis as any).PointerEvent = class PointerEvent extends win.MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
        super(type, init);
    }
};
(globalThis as any).NodeFilter = {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    SHOW_COMMENT: 128,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

mock.module("@/lib/utils", () => ({
    cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));

mock.module("@/components/FolderBrowser", () => ({
    FolderBrowser: () => null,
}));

mock.module("@/components/ui/dialog", () => ({
    Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DialogDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@/components/ui/hover-card", () => ({
    HoverCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    HoverCardTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    HoverCardContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 36,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, i) => ({
                index: i,
                start: i * 36,
                key: String(i),
                size: 36,
            })),
        measureElement: () => {},
    }),
}));

const { NewSessionWizardDialog } = await import("./NewSessionWizardDialog");

afterAll(() => mock.restore());

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
});

describe("NewSessionWizardDialog git metadata", () => {
    test("renders branch and worktree association labels from inspect_folders", async () => {
        const fetchSpy = mock((url: string | URL, init?: RequestInit) => {
            const href = typeof url === "string" ? url : url.toString();
            if (href.includes("/recent-folders")) {
                return Promise.resolve(
                    new Response(JSON.stringify({ folders: ["/code/repo", "/code/repo-wt"] })),
                );
            }
            if (href.includes("/folders/inspect")) {
                const body = JSON.parse((init?.body as string) ?? "{}") as { paths?: string[] };
                const folders = (body.paths ?? []).map((p) => {
                    if (p === "/code/repo") {
                        return { path: p, isGit: true, repoRoot: p, branch: "main" };
                    }
                    if (p === "/code/repo-wt") {
                        return {
                            path: p,
                            isGit: true,
                            repoRoot: p,
                            branch: "fix",
                            isWorktree: true,
                            mainRepoPath: "/code/repo",
                        };
                    }
                    return { path: p, isGit: false };
                });
                return Promise.resolve(new Response(JSON.stringify({ ok: true, folders })));
            }
            return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        });
        (globalThis as any).fetch = fetchSpy;

        const { container } = render(
            <NewSessionWizardDialog
                open={true}
                onOpenChange={() => {}}
                runners={[
                    {
                        runnerId: "runner-1",
                        name: "Test Runner",
                        sessionCount: 0,
                        isOnline: true,
                    },
                ]}
                preselectedRunnerId="runner-1"
                onSpawn={async () => {}}
            />,
        );

        await waitFor(() => {
            expect(container.textContent).toContain("repo");
            expect(container.textContent).toContain("repo-wt");
        });

        await waitFor(() => {
            expect(container.textContent).toContain("main");
            expect(container.textContent).toContain("fix");
        });
        expect(container.textContent).toContain("worktree of repo");
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining("/folders/inspect"),
            expect.objectContaining({ method: "POST" }),
        );
    });

    test("hover worktree action creates a worktree and starts a session", async () => {
        const fetchSpy = mock((url: string | URL, init?: RequestInit) => {
            const href = typeof url === "string" ? url : url.toString();
            if (href.includes("/recent-folders")) {
                return Promise.resolve(new Response(JSON.stringify({ folders: ["/code/repo"] })));
            }
            if (href.includes("/folders/inspect")) {
                return Promise.resolve(
                    new Response(JSON.stringify({
                        ok: true,
                        folders: [{ path: "/code/repo", isGit: true, repoRoot: "/code/repo", branch: "main" }],
                    })),
                );
            }
            if (href.includes("/worktrees/add")) {
                const body = JSON.parse((init?.body as string) ?? "{}") as { branch?: string; cwd?: string; path?: string };
                return Promise.resolve(
                    new Response(JSON.stringify({ ok: true, branch: body.branch, path: body.path })),
                );
            }
            return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        });
        (globalThis as any).fetch = fetchSpy;

        const spawnSpy = mock(async (_runnerId: string, _cwd: string | undefined) => {});

        const { getByTitle, getByText, getByLabelText, container } = render(
            <NewSessionWizardDialog
                open={true}
                onOpenChange={() => {}}
                runners={[
                    {
                        runnerId: "runner-1",
                        name: "Test Runner",
                        sessionCount: 0,
                        isOnline: true,
                    },
                ]}
                preselectedRunnerId="runner-1"
                onSpawn={spawnSpy}
            />,
        );

        await waitFor(() => expect(container.textContent).toContain("repo"));

        const rowButton = getByTitle("/code/repo");
        const trigger = rowButton.parentElement;
        expect(trigger).not.toBeNull();
        fireEvent.pointerEnter(trigger!);

        await waitFor(() => expect(getByText("New Worktree From…")).toBeTruthy());

        fireEvent.click(getByText("New Worktree From…"));

        await waitFor(() => expect(container.textContent).toContain("New worktree"));
        expect(container.textContent).toContain("/code/repo");
        expect(container.textContent).toContain("Will create");
        expect(container.textContent).toContain("/code/repo-main");

        fireEvent.click(getByText("Create & Start Session"));

        await waitFor(() => {
            expect(spawnSpy).toHaveBeenCalledWith("runner-1", "/code/repo-main");
        });
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining("/worktrees/add"),
            expect.objectContaining({ method: "POST" }),
        );
    });
});
