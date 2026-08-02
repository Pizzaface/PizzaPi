import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

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
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);

const fetchSpy = mock(async () => ({
  ok: true,
  json: async () => ({ content: "AAAA", size: 3, truncated: false }),
}) as Response);
(globalThis as any).fetch = fetchSpy;

mock.module("@/components/ui/spinner", () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

const actualUtils = await import("../../lib/utils");
mock.module("@/lib/utils", () => actualUtils);

const { VideoViewer } = await import("./video-viewer");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  fetchSpy.mockClear();
});

describe("VideoViewer", () => {
  test("renders the browser video player with the file MIME type", async () => {
    const { container } = render(
      <VideoViewer runnerId="r1" filePath="/repo/demo.webm" onClose={mock(() => {})} />,
    );

    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    const video = container.querySelector("video")!;
    expect(video.controls).toBe(true);
    expect(video.getAttribute("src")).toBe("data:video/webm;base64,AAAA");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/runners/r1/read-file",
      expect.objectContaining({
        body: JSON.stringify({ path: "/repo/demo.webm", encoding: "base64", rejectTruncated: true }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test("announces the loading state", () => {
    fetchSpy.mockImplementationOnce(async () => new Promise<Response>(() => {}));

    const { getByRole, unmount } = render(
      <VideoViewer runnerId="r1" filePath="/repo/demo.mp4" onClose={mock(() => {})} />,
    );

    expect(getByRole("status").textContent).toContain("Loading video preview");
    unmount();
  });

  test("announces asynchronous preview errors", async () => {
    fetchSpy.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ size: 11 * 1024 * 1024, truncated: true }),
    }) as Response);

    const { getByRole } = render(
      <VideoViewer runnerId="r1" filePath="/repo/large.mp4" onClose={mock(() => {})} />,
    );

    await waitFor(() => expect(getByRole("alert").textContent).toContain("too large"));
  });

  test("aborts the file request when the preview closes", async () => {
    let signal: AbortSignal | undefined;
    fetchSpy.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });

    const { unmount } = render(
      <VideoViewer runnerId="r1" filePath="/repo/demo.mp4" onClose={mock(() => {})} />,
    );
    await waitFor(() => expect(signal).toBeDefined());

    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
