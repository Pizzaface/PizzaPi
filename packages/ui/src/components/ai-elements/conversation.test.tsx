import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SigilProvider } from "@/components/sigils/SigilContext";
import { Conversation, MessageCopyButton } from "./conversation";

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

test("Conversation disables its implicit role=log live region instead of announcing streamed additions", () => {
  const view = render(<Conversation>content</Conversation>);
  const log = view.container.querySelector('[role="log"]')!;
  // role="log" implies aria-live="polite" by default; it must be explicitly
  // turned off so streamed markdown nodes and pagination prepends are never
  // auto-announced. Completed-turn announcements happen via SessionViewer's
  // dedicated polite sr-only region instead.
  expect(log.getAttribute("aria-live")).toBe("off");
  expect(log.hasAttribute("aria-relevant")).toBe(false);
});
