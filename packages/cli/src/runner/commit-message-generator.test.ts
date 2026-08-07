import { describe, test, expect } from "bun:test";
import { parseModelMessage } from "./commit-message-generator.js";

describe("parseModelMessage", () => {
    test("parses a conventional subject + body", () => {
        const r = parseModelMessage("feat(ui): add diff modal\n\n- thing one\n- thing two");
        expect(r.subject).toBe("feat(ui): add diff modal");
        expect(r.body).toBe("- thing one\n- thing two");
    });

    test("strips markdown fences", () => {
        const r = parseModelMessage("```\nfix(server): drop pending chunk\n\nbody line\n```");
        expect(r.subject).toBe("fix(server): drop pending chunk");
        expect(r.body).toBe("body line");
    });

    test("drops preamble before the first conventional line", () => {
        const r = parseModelMessage("Here is your commit message:\n\nchore: tidy\n\nmore");
        expect(r.subject).toBe("chore: tidy");
    });

    test("falls back to the first line when not conventional", () => {
        const r = parseModelMessage("just a plain message");
        expect(r.subject).toBe("just a plain message");
        expect(r.body).toBe("");
    });
});
