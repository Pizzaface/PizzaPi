import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);

const fetchSpy = mock(async () => {
  return {
    ok: true,
    json: async () => ({ content: "hello\nworld", size: 11, truncated: false }),
  } as Response;
});
(globalThis as any).fetch = fetchSpy;

mock.module("@/components/ui/spinner", () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

mock.module("@/hooks/useGitService", () => ({
  useGitService: (_cwd: string) => ({
    available: true,
    status: { branch: "main", changes: [], ahead: 0, behind: 0, hasUpstream: true, diffStaged: "" },
  }),
}));

mock.module("@/components/git/GitBlameView", () => ({
  GitBlameView: ({ cwd, path }: { cwd: string; path: string }) => (
    <div data-testid="blame-view" data-cwd={cwd} data-path={path} />
  ),
}));

const actualUtils = await import("../../lib/utils");
mock.module("@/lib/utils", () => actualUtils);

const { FileViewer } = await import("./file-viewer");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  fetchSpy.mockClear();
});

describe("FileViewer", () => {
  test("shows blame button inside a git repo and toggles blame view", async () => {
    const { getByText, queryByText, queryByTestId } = render(
      <FileViewer runnerId="r1" filePath="/repo/readme.txt" cwd="/repo" canBlame={true} onClose={mock(() => {})} />,
    );

    await waitFor(() => expect(queryByText(/hello/)).toBeTruthy());
    expect(getByText("Blame")).toBeTruthy();

    fireEvent.click(getByText("Blame"));

    await waitFor(() => expect(queryByTestId("blame-view")).toBeTruthy());
    expect(queryByTestId("blame-view")?.getAttribute("data-path")).toBe("/repo/readme.txt");
  });

  test("hides blame button when not in a git repo", async () => {
    const { queryByText } = render(
      <FileViewer runnerId="r1" filePath="/other/readme.txt" cwd="/other" canBlame={false} onClose={mock(() => {})} />,
    );

    await waitFor(() => expect(queryByText(/hello/)).toBeTruthy());
    expect(queryByText("Blame")).toBeNull();
  });
});
