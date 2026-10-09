import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = SyntaxError;
(win as any).TypeError = TypeError;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement", "MutationObserver", "ResizeObserver", "Event", "HTMLInputElement", "getComputedStyle"]) {
  (globalThis as any)[key] = key === "window" ? win : (win as any)[key];
}
(globalThis as any).requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { SigilProvider } = await import("@/components/sigils/SigilContext");

// ConversationScrollButton only renders when the real StickToBottom context
// reports `!isAtBottom` — happy-dom never measures a real scroll gap, so
// stub the hook to exercise the "not at bottom" / visible-FAB branch.
const scrollToBottomMock = mock(() => {});
const StubStickToBottom = Object.assign(
  ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  { Content: (props: any) => props.children },
);
mock.module("use-stick-to-bottom", () => ({
  StickToBottom: StubStickToBottom,
  useStickToBottomContext: () => ({ isAtBottom: false, scrollToBottom: scrollToBottomMock }),
}));

const { Conversation, ConversationExport, ConversationScrollButton, MessageCopyButton } = await import("./conversation");

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

test("message copy button keeps its 44px touch target (tracked separately in GM Ex5W2eFk)", () => {
  const view = render(
    <SigilProvider sigilDefs={sigilDefs} panels={[]} runnerId="runner-1">
      <MessageCopyButton text="copy me" />
    </SigilProvider>,
  );

  const copy = view.getByRole("button", { name: "Copy message" });
  expect(copy.className).toContain("size-11");
  expect(copy.className).toContain("-m-2.5");
});

test("export button never drops below 44px on narrow screens, shrinks to 36px from md up", () => {
  const view = render(
    <SigilProvider sigilDefs={sigilDefs} panels={[]} runnerId="runner-1">
      <ConversationExport messages={[]} />
    </SigilProvider>,
  );

  const exportButton = view.getByRole("button", { name: "Export conversation" });
  // Narrow screens (including fine-pointer narrow viewports) keep the 44px
  // floor; only md+ shrinks to size-9, and pointer-coarse re-grows it.
  expect(exportButton.className).toContain("size-11");
  expect(exportButton.className).toContain("md:size-9");
  expect(exportButton.className).toContain("pointer-coarse:min-h-11");
  expect(exportButton.className).toContain("pointer-coarse:min-w-11");
});

test("scroll-to-bottom FAB keeps desktop density, growing to 44px only on touch", () => {
  const view = render(<ConversationScrollButton />);

  const scrollButton = view.container.querySelector("button");
  expect(scrollButton).not.toBeNull();
  // Button's "icon" size default (size-9) is left alone — only coarse
  // pointers grow this FAB to 44px.
  expect(scrollButton!.className).not.toContain("size-11");
  expect(scrollButton!.className).toContain("pointer-coarse:min-h-11");
  expect(scrollButton!.className).toContain("pointer-coarse:min-w-11");

  fireEvent.click(scrollButton!);
  expect(scrollToBottomMock).toHaveBeenCalled();
});
