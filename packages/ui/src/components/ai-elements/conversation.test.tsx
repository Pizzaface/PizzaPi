import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SigilProvider } from "@/components/sigils/SigilContext";
import { MessageCopyButton } from "./conversation";

(globalThis.window as unknown as { SyntaxError?: typeof SyntaxError }).SyntaxError = SyntaxError;

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

const sigilDefs = [{ type: "pr", label: "PR", serviceId: "github", resolve: "/resolve/{id}", resolvePort: 1234 }];

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
});

test("MessageCopyButton copies a sigil's resolved text", async () => {
  globalThis.fetch = (async () => Response.json({ text: "Fix authentication flow", title: "PR title" })) as typeof fetch;
  const writeText = mock(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  const view = render(
    <SigilProvider sigilDefs={sigilDefs} panels={[]} runnerId="runner-1">
      <MessageCopyButton text="See [[pr:42]]" />
    </SigilProvider>,
  );

  await act(async () => {
    fireEvent.click(view.container.querySelector("button")!);
  });

  expect(writeText).toHaveBeenCalledWith("See Fix authentication flow");
});
