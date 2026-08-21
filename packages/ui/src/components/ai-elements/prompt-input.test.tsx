import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";

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
(globalThis as any).File = win.File;
(globalThis as any).FileReader = win.FileReader;
(globalThis as any).FormData = win.FormData;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} = await import("./prompt-input");

type SubmitResult = boolean | undefined;

const AttachmentCount = () => {
  const { files } = usePromptInputAttachments();
  return <div data-count={files.length} data-testid="attachment-count" />;
};

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let revokeObjectURL = mock(() => {});

beforeEach(() => {
  revokeObjectURL = mock(() => {});
  URL.createObjectURL = () => "blob:attachment";
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  cleanup();
  win.document.body.innerHTML = "";
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

async function submitWithAttachment(result: SubmitResult) {
  // Simulates an untyped callback violating the boolean contract at runtime.
  const onSubmit = mock(async (): Promise<boolean> => result!);
  const view = render(
    <PromptInput onSubmit={onSubmit}>
      <AttachmentCount />
      <PromptInputTextarea />
      <PromptInputSubmit />
    </PromptInput>,
  );

  const file = new File(["attachment"], "attachment.txt", { type: "text/plain" });
  fireEvent.change(view.getByLabelText("Upload files"), { target: { files: [file] } });
  await waitFor(() => expect(view.getByTestId("attachment-count").dataset.count).toBe("1"));

  await act(async () => {
    fireEvent.submit(view.container.querySelector("form")!);
  });

  return view;
}

describe("PromptInput submit", () => {
  test("retains attachments and blob URLs when send returns false", async () => {
    const view = await submitWithAttachment(false);

    expect(view.getByTestId("attachment-count").dataset.count).toBe("1");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test("retains attachments and blob URLs when send returns undefined", async () => {
    const view = await submitWithAttachment(undefined);

    expect(view.getByTestId("attachment-count").dataset.count).toBe("1");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test("clears attachments and revokes blob URLs once when send returns true", async () => {
    const view = await submitWithAttachment(true);

    await waitFor(() => expect(view.getByTestId("attachment-count").dataset.count).toBe("0"));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
  });

  test("revokes retained attachment URLs when unmounted", async () => {
    const view = await submitWithAttachment(false);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
  });
});
