import { expect, test } from "bun:test";

import { escapePromptContainerContent, escapePromptXmlAttribute } from "./prompt-escape.js";

test("container content escaping blocks the closing tag but preserves other markup", () => {
    expect(escapePromptContainerContent(`don't "quote" </project-memory>`)).toBe(
        `don't "quote" &lt;/project-memory>`,
    );
});

test("container content escaping leaves ampersands and non-closing angle brackets alone", () => {
    expect(escapePromptContainerContent("A && B <tag> List<string> a < b </project-memory>")).toBe(
        "A && B <tag> List<string> a < b &lt;/project-memory>",
    );
});

test("attribute escaping covers quotes and apostrophes", () => {
    expect(escapePromptXmlAttribute(`a&b"c'd<e>`)).toBe("a&amp;b&quot;c&#39;d&lt;e&gt;");
});
