import { expect, test } from "bun:test";

import { escapePromptXmlAttribute, escapePromptXmlText } from "./prompt-escape.js";

test("element text escaping preserves quotes while blocking XML breakout", () => {
    expect(escapePromptXmlText(`don't "quote" </project-memory>`)).toBe(`don't "quote" &lt;/project-memory&gt;`);
});

test("element text escaping handles ampersands before tag delimiters", () => {
    expect(escapePromptXmlText("A && B </project-memory>")).toBe("A &amp;&amp; B &lt;/project-memory&gt;");
});

test("attribute escaping covers quotes and apostrophes", () => {
    expect(escapePromptXmlAttribute(`a&b"c'd<e>`)).toBe("a&amp;b&quot;c&#39;d&lt;e&gt;");
});
