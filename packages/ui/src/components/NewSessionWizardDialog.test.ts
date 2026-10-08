import { afterEach, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewSessionWizardDialog } from "./NewSessionWizardDialog";
import { filterFolders } from "../lib/filterFolders.js";

(window as unknown as { SyntaxError?: ErrorConstructor; TypeError?: ErrorConstructor }).SyntaxError = globalThis.SyntaxError;
(window as unknown as { TypeError?: ErrorConstructor }).TypeError = globalThis.TypeError;
(globalThis as unknown as { Event?: typeof window.Event }).Event = window.Event;
(globalThis as unknown as { CustomEvent?: typeof window.CustomEvent }).CustomEvent = window.CustomEvent;
(globalThis as unknown as { getComputedStyle?: typeof window.getComputedStyle }).getComputedStyle = window.getComputedStyle.bind(window);
(globalThis as unknown as { MutationObserver?: typeof window.MutationObserver }).MutationObserver = window.MutationObserver;

const originalFetch = globalThis.fetch;

afterEach(() => {
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

        render(React.createElement(NewSessionWizardDialog, {
            open: true,
            onOpenChange: () => {},
            runners: [RUNNER],
            runnersLoading: false,
            onSpawn,
        }));

        expect(await screen.findByText("Step 2 of 2")).toBeTruthy();
        const modelSelect = await screen.findByLabelText("Model") as HTMLSelectElement;
        await waitFor(() => expect(modelSelect.options.length).toBe(2));

        fireEvent.change(modelSelect, { target: { value: "openrouter\topenai/gpt-5.5" } });
        fireEvent.click(screen.getByText("Start Session"));

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
