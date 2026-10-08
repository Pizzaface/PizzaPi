import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = SyntaxError;
(win as any).TypeError = TypeError;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement", "MutationObserver", "Event", "HTMLInputElement"]) {
  (globalThis as any)[key] = key === "window" ? win : (win as any)[key];
}

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { SigilProvider } = await import("@/components/sigils/SigilContext");
const { Conversation, ConversationExport, MessageCopyButton } = await import("./conversation");

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

test("message copy and export buttons keep 44px touch targets", () => {
  const view = render(
    <SigilProvider sigilDefs={sigilDefs} panels={[]} runnerId="runner-1">
      <MessageCopyButton text="copy me" />
      <ConversationExport messages={[]} />
    </SigilProvider>,
  );

  const copy = view.getByRole("button", { name: "Copy message" });
  expect(copy.className).toContain("size-11");
  expect(copy.className).toContain("-m-2.5");
  expect(copy.className).not.toContain("md:size-6");

  const exportButton = view.getByRole("button", { name: "Export conversation" });
  expect(exportButton.className).toContain("size-11");
  expect(exportButton.className).not.toContain("md:size-9");
});
