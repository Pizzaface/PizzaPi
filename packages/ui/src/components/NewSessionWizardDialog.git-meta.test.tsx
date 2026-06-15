import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, waitFor } from "@testing-library/react";
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

        expect(container.textContent).toContain("main");
        expect(container.textContent).toContain("fix");
        expect(container.textContent).toContain("worktree of repo");
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining("/folders/inspect"),
            expect.objectContaining({ method: "POST" }),
        );
    });
});
