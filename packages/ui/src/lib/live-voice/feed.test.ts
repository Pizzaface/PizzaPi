import { expect, test } from "bun:test";
import { liveFeed } from "./feed";

test("Live feed shows what was said and what each tool is doing", () => {
    const messages = [
        { role: "user", content: "Build it please" },
        { role: "assistant", content: [
            { type: "text", text: "Running the build." },
            { type: "toolCall", id: "a", name: "bash", arguments: { command: "bun run build", title: "Production UI build" } },
            { type: "toolCall", id: "b", name: "edit", arguments: { path: "src/x/audio.ts" } },
            { type: "toolCall", id: "c", name: "read", arguments: { path: "/tmp/notes.md" } },
        ] },
        { role: "toolResult", toolCallId: "b", isError: true },
    ];
    expect(liveFeed(messages, new Map([["a", "bash"]]))).toEqual([
        { kind: "user", key: "0", text: "Build it please" },
        { kind: "agent", key: "1", text: "Running the build." },
        { kind: "tool", key: "1:a", text: "Production UI build", detail: "bun run build", state: "running" },
        { kind: "tool", key: "1:b", text: "Edited audio.ts", detail: undefined, state: "error" },
        { kind: "tool", key: "1:c", text: "Read notes.md", detail: undefined, state: "done" },
    ]);
    expect(liveFeed(messages, undefined, 2).map((i) => i.text)).toEqual(["Edited audio.ts", "Read notes.md"]);
});

test("Live feed shows the current reply in full, but only as far as it has been spoken", () => {
    const messages = [
        { role: "user", content: "Earlier" },
        { role: "assistant", content: "A long earlier answer that is not trimmed any more, even though it runs well past the old one-line limit of the feed." },
        { role: "user", content: "Status?" },
        { role: "assistant", content: [{ type: "text", text: "First. Second." }, { type: "toolCall", id: "t", name: "read", arguments: { path: "a.ts" } }] },
        { role: "assistant", content: "Third." },
    ];
    const agent = (revealed?: number) => liveFeed(messages, undefined, 8, revealed).filter((i) => i.kind === "agent").map((i) => i.text);
    expect(agent()[0]).toEndWith("limit of the feed.");
    expect(agent(0)).toHaveLength(1); // nothing of the current reply yet
    expect(agent(6)).toEqual([agent()[0], "First."]);
    expect(agent(16)).toEqual([agent()[0], "First. Second."]); // "Third." starts after the "\n\n" join
    expect(agent(22)).toEqual([agent()[0], "First. Second.", "Third."]);
});
