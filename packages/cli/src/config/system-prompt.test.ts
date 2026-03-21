import { describe, test, expect } from "bun:test";
import { BUILTIN_SYSTEM_PROMPT } from "./system-prompt.js";
import { ASK_USER_QUESTION_PROMPT_FRAGMENT } from "../prompts/ask-user-question.js";

describe("BUILTIN_SYSTEM_PROMPT", () => {
    test("contains the full AskUserQuestion fragment verbatim", () => {
        const fragmentText = ASK_USER_QUESTION_PROMPT_FRAGMENT.join(" ");
        expect(BUILTIN_SYSTEM_PROMPT).toContain(fragmentText);
    });

    test("fragment is flanked by Toggle Plan Mode section and Sandbox section", () => {
        // Verify the fragment sits in the right place in the prompt
        const beforeFragment = "Do not exit plan mode without first submitting a plan via `plan_mode` unless the task is trivial.\n";
        const firstFragmentLine = "## Asking Questions — AskUserQuestion\n";
        const lastFragmentLine = "If you are a child session, keep AskUserQuestion calls simple: one question with radio-style options.\n";
        const afterFragment = "## Sandbox\n";

        const beforeIdx = BUILTIN_SYSTEM_PROMPT.indexOf(beforeFragment);
        const firstIdx = BUILTIN_SYSTEM_PROMPT.indexOf(firstFragmentLine);
        const lastIdx = BUILTIN_SYSTEM_PROMPT.indexOf(lastFragmentLine);
        const afterIdx = BUILTIN_SYSTEM_PROMPT.indexOf(afterFragment);

        expect(beforeIdx).toBeGreaterThan(-1);
        expect(firstIdx).toBeGreaterThan(beforeIdx);
        expect(lastIdx).toBeGreaterThan(firstIdx);
        expect(afterIdx).toBeGreaterThan(lastIdx);
    });

    test("fragment includes all three question type descriptions", () => {
        const fragmentText = ASK_USER_QUESTION_PROMPT_FRAGMENT.join(" ");
        expect(fragmentText).toContain('"radio"');
        expect(fragmentText).toContain('"checkbox"');
        expect(fragmentText).toContain('"ranked"');
    });

    test("composed prompt is a non-empty string", () => {
        expect(typeof BUILTIN_SYSTEM_PROMPT).toBe("string");
        expect(BUILTIN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    test("prompt still contains all major sections", () => {
        const sections = [
            "## Spawning Sessions & Linked Sessions",
            "## Subagent Tool",
            "## Plan Mode",
            "## Toggle Plan Mode",
            "## Asking Questions — AskUserQuestion",
            "## Sandbox",
            "## PizzaPi Configuration",
        ];
        for (const section of sections) {
            expect(BUILTIN_SYSTEM_PROMPT).toContain(section);
        }
    });
});
