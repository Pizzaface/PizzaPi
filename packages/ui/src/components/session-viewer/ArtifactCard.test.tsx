/**
 * Tests for ArtifactCard — the inline rendering of a deliverable produced by
 * a session.
 */
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { ArtifactCard } = await import("./ArtifactCard");

const originalFetch = globalThis.fetch;
let requests: Array<{ path: string; encoding: string; rejectTruncated?: boolean }> = [];

beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path: body.path, encoding: body.encoding });
        return new Response(JSON.stringify({ content: "a,b\n1,2\n", size: 8 }), {
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
});

describe("ArtifactCard", () => {
    test("shows the file name and offers to open it", () => {
        const { getByText, getByLabelText } = render(
            <ArtifactCard path="/w/reports/q3.csv" kind="csv" runnerId="r1" onOpen={() => {}} />,
        );
        expect(getByText("q3.csv")).toBeDefined();
        expect(getByLabelText("Open q3.csv")).toBeDefined();
    });

    test("fetches text kinds as utf8 and renders the preview", async () => {
        const { getByText } = render(<ArtifactCard path="/w/a.csv" kind="csv" runnerId="r1" />);
        await waitFor(() => expect(requests.length).toBe(1));
        expect(requests[0]).toEqual({ path: "/w/a.csv", encoding: "utf8" });
        await waitFor(() => expect(getByText("1")).toBeDefined());
    });

    test("fetches binary kinds as base64", async () => {
        render(<ArtifactCard path="/w/a.png" kind="image" runnerId="r1" />);
        await waitFor(() => expect(requests.length).toBe(1));
        expect(requests[0]!.encoding).toBe("base64");
    });

    test("does not eagerly fetch a file it cannot preview", async () => {
        const { getByText } = render(<ArtifactCard path="/w/deck.pptx" kind="download" runnerId="r1" />);
        await waitFor(() => expect(getByText(/download to open/i)).toBeDefined());
        expect(requests.length).toBe(0);
    });

    test("a non-previewable artifact can still be downloaded", async () => {
        // Regression: the download button was disabled for exactly the kind of
        // file whose only affordance is downloading.
        const { getByLabelText } = render(<ArtifactCard path="/w/deck.pptx" kind="download" runnerId="r1" />);
        const button = getByLabelText("Download deck.pptx") as unknown as HTMLButtonElement;
        expect(button.disabled).toBe(false);
    });

    test("without a runner there is nothing to fetch from", async () => {
        const { getByText } = render(<ArtifactCard path="/w/a.csv" kind="csv" />);
        await waitFor(() => expect(getByText(/No runner available/i)).toBeDefined());
        expect(requests.length).toBe(0);
    });

    test("a truncated preview says so and never becomes the downloaded file", async () => {
        // Regression: a preview is capped by the read API, so building a
        // download from it would silently save a corrupt prefix.
        globalThis.fetch = (async (_input: any, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            requests.push({ path: body.path, encoding: body.encoding, rejectTruncated: body.rejectTruncated });
            return new Response(JSON.stringify({ content: "a,b\n1,2\n", size: 999999, truncated: true }), {
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        const { getByText, getByLabelText } = render(<ArtifactCard path="/w/big.csv" kind="csv" runnerId="r1" />);
        await waitFor(() => expect(getByText(/download for the whole thing/i)).toBeDefined());

        fireEvent.click(getByLabelText("Download big.csv"));
        await waitFor(() => expect(requests.length).toBe(2));
        // The download refetches the whole file and refuses a truncated one.
        expect(requests[1]).toEqual({ path: "/w/big.csv", encoding: "base64", rejectTruncated: true });
    });

    test("a failed read reports instead of hanging on a spinner", async () => {
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ error: "permission denied" }), { status: 403 })) as typeof fetch;
        const { getByText } = render(<ArtifactCard path="/w/a.csv" kind="csv" runnerId="r1" />);
        await waitFor(() => expect(getByText(/permission denied/i)).toBeDefined());
    });

    test("a previewable artifact offers an expand affordance", () => {
        const { getByLabelText } = render(<ArtifactCard path="/w/reports/q3.csv" kind="csv" runnerId="r1" />);
        expect(getByLabelText("Expand q3.csv")).toBeDefined();
    });

    test("a download-only artifact offers no expand affordance", () => {
        const { queryByLabelText } = render(<ArtifactCard path="/w/deck.pptx" kind="download" runnerId="r1" />);
        expect(queryByLabelText("Expand deck.pptx")).toBeNull();
    });

    test("expand is hidden when there is no runner to fetch from", () => {
        const { queryByLabelText } = render(<ArtifactCard path="/w/a.csv" kind="csv" />);
        expect(queryByLabelText("Expand a.csv")).toBeNull();
    });

    test("shows an explicit title alongside the filename", () => {
        const { getByText } = render(<ArtifactCard path="/w/q3.csv" kind="csv" title="Q3 Report" runnerId="r1" />);
        expect(getByText("Q3 Report")).toBeDefined();
        expect(getByText("q3.csv")).toBeDefined();
    });

    test("resolves a relative deliverable path against the session cwd", async () => {
        render(<ArtifactCard path="report.csv" kind="csv" runnerId="r1" cwd="/w/space" />);
        await waitFor(() => expect(requests.length).toBe(1));
        expect(requests[0]!.path).toBe("/w/space/report.csv");
    });

    test("leaves an absolute deliverable path untouched", async () => {
        render(<ArtifactCard path="/w/abs.csv" kind="csv" runnerId="r1" cwd="/other" />);
        await waitFor(() => expect(requests.length).toBe(1));
        expect(requests[0]!.path).toBe("/w/abs.csv");
    });
});
