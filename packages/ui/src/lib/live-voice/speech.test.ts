import { describe, expect, test } from "bun:test";
import { assistantText, isEcho, replyText, SpeechChunker, toSpeakable } from "./speech";

describe("SpeechChunker", () => {
    test("emits only completed sentences as text streams in", () => {
        const c = new SpeechChunker();
        expect(c.push("Sure, running")).toEqual([]);
        expect(c.push("Sure, running the tests. Three fa")).toEqual(["Sure, running the tests."]);
        expect(c.push("Sure, running the tests. Three failed! All in relay")).toEqual(["Three failed!"]);
        expect(c.flush("Sure, running the tests. Three failed! All in relay")).toEqual(["All in relay"]);
        expect(c.ends).toEqual([51]);
    });

    test("never speaks fenced code, even while the fence is still open", () => {
        const c = new SpeechChunker();
        expect(c.push("Here is the fix:\n```ts\nconst a = 1;")).toEqual(["Here is the fix:"]);
        expect(c.push("Here is the fix:\n```ts\nconst a = 1;\n```\nThat should do it.")).toEqual([]);
        expect(c.flush("Here is the fix:\n```ts\nconst a = 1;\n```\nThat should do it.")).toEqual(["That should do it."]);
    });

    test("paragraph breaks are boundaries", () => {
        const c = new SpeechChunker();
        expect(c.push("Done\n\nNext")).toEqual(["Done"]);
    });
});

describe("replyText", () => {
    test("joins assistant text after the last user message, survives partial->final swap", () => {
        const before = [
            { role: "user", content: "old" },
            { role: "assistant", content: [{ type: "text", text: "Old reply." }] },
            { role: "user", content: "run tests" },
            { role: "assistant", content: [{ type: "text", text: "On it." }] },
            { role: "toolResult", content: "ok" },
            { role: "assistant", content: [{ type: "text", text: "All green" }] },
        ];
        expect(replyText(before)).toBe("On it.\n\nAll green");
        const c = new SpeechChunker();
        expect(c.push(replyText(before))).toEqual(["On it."]);
        // final message replaces the partial (new key, same text + more)
        const after = [...before.slice(0, 5), { role: "assistant", content: [{ type: "text", text: "All green." }] }];
        expect(c.flush(replyText(after))).toEqual(["All green."]);
    });
    test("shrinking text never re-reads", () => {
        const c = new SpeechChunker();
        c.push("One. Two. ");
        expect(c.push("One. ")).toEqual([]);
        expect(c.push("One. Three. ")).toEqual(["Three."]);
    });
});

describe("toSpeakable", () => {
    test("strips markdown chrome", () => {
        expect(toSpeakable("## Result\n- **3** tests failed in `relay`\n- see [the log](http://x/y)")).toBe("Result\n3 tests failed in relay\nsee the log");
        expect(toSpeakable("Open https://example.com/a now")).toBe("Open a link now");
        expect(toSpeakable("| a | b |\n|---|---|\nAfter table")).toBe("After table");
        expect(toSpeakable("Idea [[gm-idea:abc]] captured")).toBe("Idea captured");
    });
    test("keeps snake_case words intact", () => {
        expect(toSpeakable("call send_message now")).toBe("call send_message now");
    });
});

describe("assistantText", () => {
    test("only text blocks", () => {
        expect(
            assistantText([
                { type: "thinking", thinking: "hmm" },
                { type: "text", text: "Hi." },
                { type: "toolCall", name: "bash" },
                { type: "text", text: "Bye." },
            ]),
        ).toBe("Hi.\n\nBye.");
        expect(assistantText("plain")).toBe("plain");
        expect(assistantText(undefined)).toBe("");
    });
});

test("isEcho matches the agent's own words, not new requests", () => {
    const spoken = "I'll **run the tests** now. Then I'll check the build.";
    expect(isEcho("run the tests now", spoken)).toBe(true);
    expect(isEcho("I'll check the bill", spoken)).toBe(true); // tolerates a misheard word
    expect(isEcho("stop, deploy it instead", spoken)).toBe(false);
    expect(isEcho("", spoken)).toBe(false);
    expect(isEcho("time and hit", spoken)).toBe(false); // 3+ words still need overlap
    expect(isEcho("Nat, see", spoken)).toBe(true); // short garbled fragment
    expect(isEcho("stop", spoken)).toBe(false);
    expect(isEcho("wait please", spoken)).toBe(false);
});
