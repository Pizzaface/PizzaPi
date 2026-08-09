import { describe, test, expect, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { GitCommitForm } from "./GitCommitForm";

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

afterEach(() => cleanup());

describe("GitCommitForm", () => {
    test("collapses to a hint when nothing is staged", () => {
        const { queryByPlaceholderText, getByText } = render(
            <GitCommitForm hasStagedChanges={false} stagedCount={0} onCommit={() => {}} isCommitting={false} />,
        );
        expect(getByText("Stage changes to enable committing")).toBeTruthy();
        expect(queryByPlaceholderText("Describe your changes…")).toBeNull();
    });

    test("shows staged count in the CTA and commit button", () => {
        const { getByText } = render(
            <GitCommitForm hasStagedChanges stagedCount={3} onCommit={() => {}} isCommitting={false} />,
        );
        expect(getByText("3 staged")).toBeTruthy();
        expect(getByText("Commit 3")).toBeTruthy();
    });

    test("commit fires with the message and clears it", async () => {
        let committed = "";
        const { getByText, getByRole } = render(
            <GitCommitForm
                hasStagedChanges
                stagedCount={1}
                onCommit={(m) => (committed = m)}
                isCommitting={false}
                onSuggest={async () => ({ subject: "fix: thing", body: "", type: "fix", scope: "", files: [] })}
            />,
        );
        // Populate the message via Auto (state-driven), then commit.
        fireEvent.click(getByText("Auto"));
        await waitFor(() => expect(getByRole("textbox").textContent).not.toBe(""));
        await waitFor(() => {
            expect((getByText("Commit 1").closest("button") as HTMLButtonElement).disabled).toBe(false);
        });
        fireEvent.click(getByText("Commit 1"));
        await waitFor(() => expect(committed).toBe("fix: thing"));
        await waitFor(() => expect(getByRole("textbox").textContent).toBe(""));
    });

    test("Auto fills the message from a suggestion", async () => {
        const { getByText, getByRole } = render(
            <GitCommitForm
                hasStagedChanges
                stagedCount={1}
                onCommit={() => {}}
                isCommitting={false}
                onSuggest={async () => ({ subject: "feat(ui): add diff modal", body: "- thing", type: "feat", scope: "ui", files: [] })}
            />,
        );
        fireEvent.click(getByText("Auto"));
        await waitFor(() => {
            const ta = getByRole("textbox") as HTMLTextAreaElement;
            expect(ta.value).toContain("feat(ui): add diff modal");
        });
    });

    test("Auto button is hidden/disabled when no onSuggest is provided", () => {
        const { queryByText } = render(
            <GitCommitForm hasStagedChanges stagedCount={1} onCommit={() => {}} isCommitting={false} />,
        );
        const auto = queryByText("Auto");
        // Button exists but is disabled because no onSuggest is wired.
        expect((auto?.closest("button") as HTMLButtonElement).disabled).toBe(true);
    });
});
