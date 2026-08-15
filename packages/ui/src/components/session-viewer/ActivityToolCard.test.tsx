/**
 * Tests for ActivityToolCard — the collapsed, human-language rendering of a
 * tool call used by modes with toolRendering: "activity".
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
// happy-dom's selector parser constructs window.SyntaxError; without this the
// first querySelectorAll throws "undefined is not a constructor".
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { ActivityToolCard } = await import("./ActivityToolCard");

afterEach(() => cleanup());

describe("ActivityToolCard", () => {
    test("renders the tool call as one human-language line", () => {
        const { getByRole } = render(
            <ActivityToolCard toolName="write" toolInput={{ file_path: "/w/q3-review.md" }}>
                <div>detailed card</div>
            </ActivityToolCard>,
        );
        expect(getByRole("button").textContent).toContain("Created q3-review.md");
    });

    test("hides the detailed card until expanded, then shows it", () => {
        const { getByRole, queryByText } = render(
            <ActivityToolCard toolName="bash" toolInput={{ command: "ls -la" }}>
                <div>detailed card</div>
            </ActivityToolCard>,
        );

        // Collapsed by default — the terminal output is not what a work mode leads with.
        expect(queryByText("detailed card")).toBeNull();
        expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");

        fireEvent.click(getByRole("button"));

        // Nothing is hidden from the user — detail is one click away.
        expect(queryByText("detailed card")).not.toBeNull();
        expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
    });

    test("collapses again on a second click", () => {
        const { getByRole, queryByText } = render(
            <ActivityToolCard toolName="read" toolInput={{ path: "/w/a.md" }}>
                <div>detailed card</div>
            </ActivityToolCard>,
        );
        fireEvent.click(getByRole("button"));
        fireEvent.click(getByRole("button"));
        expect(queryByText("detailed card")).toBeNull();
    });

    test("shows the command as secondary detail for bash", () => {
        const { getByRole } = render(
            <ActivityToolCard toolName="bash" toolInput={{ command: "pandoc report.md -o report.pdf" }} />,
        );
        expect(getByRole("button").textContent).toContain("pandoc report.md -o report.pdf");
    });

    test("an errored tool call still renders its activity line", () => {
        const { getByRole } = render(
            <ActivityToolCard toolName="web_fetch" toolInput={{ url: "https://example.com" }} isError>
                <div>detailed card</div>
            </ActivityToolCard>,
        );
        expect(getByRole("button").textContent).toContain("Read example.com");
    });

    test("renders without a detailed child (nothing to expand)", () => {
        const { getByRole } = render(<ActivityToolCard toolName="update_todo" toolInput={{}} />);
        fireEvent.click(getByRole("button"));
        expect(getByRole("button").textContent).toContain("Updated the plan");
    });
});
