import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { filterFolders } from "../lib/filterFolders.js";

// Install our own happy-dom Window, matching the pattern sibling test files
// use (CombinedPanel.test.tsx, DockedPanelGroup.test.tsx, GitDiffModal.test.tsx,
// etc.) — rather than patching a few constructors onto whatever `window`
// happens to be ambient. Patching the ambient window instead of owning it
// was fragile: the global `screen` export from @testing-library/dom binds to
// `document.body` once, the first time the module is imported in this
// process. If a *prior* file already swapped in its own Window without
// restoring it, `screen` would query a stale document while `render()`
// mounts into the live (different) one — `screen.findByText` then times out
// against an empty `<body />`.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

// The real Radix Dialog mounts a FocusScope that dispatches a native
// CustomEvent on mount (`focusScope.autoFocusOnMount`) through happy-dom's
// EventTarget, which checks `instanceof` its own internal Event class.
// Making that pass means patching `globalThis.CustomEvent`/`Event` to a
// happy-dom-compatible pair — but that patch has no file-scoped way to
// unpatch itself, and it leaks into whichever test file runs next (it broke
// lib/ntfy-push.test.ts, which needs the native constructors). Sibling
// dialog-rendering tests (GitDiffModal.test.tsx) avoid the whole problem by
// mocking the dialog chrome instead of exercising real Radix internals —
// this test does the same.
mock.module("@/components/ui/dialog", () => ({
    Dialog: ({ open = true, children }: { open?: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...props}>{children}</h2>,
    DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
    DialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

const { NewSessionWizardDialog } = await import("./NewSessionWizardDialog");

afterAll(() => mock.restore());

const originalFetch = globalThis.fetch;

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
});

/**
 * Unit tests for the recent-project filtering logic used in NewSessionWizardDialog.
 *
 * Tests the production `filterFolders` function from lib/filterFolders.ts:
 *   - Case-insensitive substring match
 *   - OR logic: match if found in full path OR basename
 */

const RUNNER = {
    runnerId: "runner-1",
    name: "Kitchen Mac",
    sessionCount: 0,
    roots: ["/Users/jordan"],
    isOnline: true,
    platform: "darwin",
};

const FOLDERS = [
    "/home/user/src/project",
    "/code/PizzaPi",
    "/code/pizza-tools",
    "/home/user/work/notes",
    "/tmp/scratch",
    "/home/src-archive/old",
];

describe("NewSessionWizardDialog", () => {
    test("shows progress and passes the selected model to spawn", async () => {
        globalThis.fetch = mock((url: RequestInfo | URL) => {
            const path = String(url);
            if (path.includes("/models")) {
                return Promise.resolve(Response.json({
                    models: [{ provider: "openrouter", id: "openai/gpt-5.5", name: "GPT-5.5" }],
                }));
            }
            if (path.includes("/recent-folders")) {
                return Promise.resolve(Response.json({ folders: [] }));
            }
            return Promise.resolve(Response.json({}));
        }) as unknown as typeof fetch;
        const onSpawn = mock(async () => {});

        const { findByText, findByLabelText, getByText } = render(React.createElement(NewSessionWizardDialog, {
            open: true,
            onOpenChange: () => {},
            runners: [RUNNER],
            runnersLoading: false,
            onSpawn,
        }));

        expect(await findByText("Step 2 of 2")).toBeTruthy();
        const modelSelect = await findByLabelText("Model") as HTMLSelectElement;
        await waitFor(() => expect(modelSelect.options.length).toBe(2));

        fireEvent.change(modelSelect, { target: { value: "openrouter\topenai/gpt-5.5" } });
        fireEvent.click(getByText("Start Session"));

        await waitFor(() => expect(onSpawn).toHaveBeenCalledWith(
            "runner-1",
            undefined,
            { provider: "openrouter", id: "openai/gpt-5.5" },
        ));
    });
});

describe("filterFolders", () => {
    test("empty query returns all folders", () => {
        expect(filterFolders(FOLDERS, "")).toEqual(FOLDERS);
        expect(filterFolders(FOLDERS, "   ")).toEqual(FOLDERS);
    });

    test("case-insensitive match on full path", () => {
        const result = filterFolders(FOLDERS, "PIZZAPI");
        expect(result).toContain("/code/PizzaPi");
    });

    test("case-insensitive match on basename", () => {
        const result = filterFolders(FOLDERS, "pizza");
        expect(result).toContain("/code/PizzaPi");
        expect(result).toContain("/code/pizza-tools");
    });

    test("OR logic — matches if in full path even if not in basename", () => {
        // 'src' appears in the full path '/home/user/src/project' and '/home/src-archive/old'
        // but not necessarily as the basename
        const result = filterFolders(FOLDERS, "src");
        expect(result).toContain("/home/user/src/project");
        expect(result).toContain("/home/src-archive/old");
    });

    test("no match returns empty array", () => {
        const result = filterFolders(FOLDERS, "xyzzy-nonexistent");
        expect(result).toHaveLength(0);
    });

    test("filters to single exact basename match", () => {
        const result = filterFolders(FOLDERS, "scratch");
        expect(result).toEqual(["/tmp/scratch"]);
    });

    test("full path substring match", () => {
        // 'work' appears in the full path '/home/user/work/notes'
        const result = filterFolders(FOLDERS, "work");
        expect(result).toContain("/home/user/work/notes");
    });

    test("empty folders list returns empty", () => {
        expect(filterFolders([], "pizza")).toEqual([]);
    });
});
