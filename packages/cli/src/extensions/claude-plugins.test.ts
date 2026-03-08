/**
 * Tests for Claude Code Plugin adapter — template expansion.
 */
import { describe, test, expect } from "bun:test";
import { expandArguments } from "./claude-plugins.js";

describe("expandArguments", () => {
    test("expands $ARGUMENTS with the full args string", () => {
        expect(expandArguments("Run $ARGUMENTS now", "foo bar")).toBe("Run foo bar now");
    });

    test("expands ${ARGUMENTS} with the full args string", () => {
        expect(expandArguments("Run ${ARGUMENTS} now", "foo bar")).toBe("Run foo bar now");
    });

    test("expands positional $ARGUMENTS[N] to individual args", () => {
        expect(expandArguments("$ARGUMENTS[0] and $ARGUMENTS[1]", "foo bar")).toBe("foo and bar");
    });

    test("positional placeholders are expanded BEFORE global $ARGUMENTS", () => {
        // This is the core bug fix: if global runs first, $ARGUMENTS[0] becomes "foo bar[0]"
        const template = "Deploy $ARGUMENTS[0] with $ARGUMENTS";
        expect(expandArguments(template, "staging extra")).toBe("Deploy staging with staging extra");
    });

    test("mixed positional and global in complex template", () => {
        const template = "Branch: $ARGUMENTS[0], env: $ARGUMENTS[1], all: $ARGUMENTS";
        expect(expandArguments(template, "main prod")).toBe("Branch: main, env: prod, all: main prod");
    });

    test("out-of-range positional index resolves to empty string", () => {
        expect(expandArguments("$ARGUMENTS[5]", "only-one")).toBe("");
    });

    test("handles undefined args", () => {
        expect(expandArguments("$ARGUMENTS", undefined)).toBe("");
        expect(expandArguments("$ARGUMENTS[0]", undefined)).toBe("");
    });

    test("handles empty args", () => {
        expect(expandArguments("$ARGUMENTS", "")).toBe("");
        expect(expandArguments("$ARGUMENTS[0]", "")).toBe("");
    });

    test("template with no placeholders is unchanged", () => {
        expect(expandArguments("no placeholders here", "foo")).toBe("no placeholders here");
    });

    test("multiple occurrences of $ARGUMENTS are all replaced", () => {
        expect(expandArguments("$ARGUMENTS and $ARGUMENTS", "x")).toBe("x and x");
    });

    test("positional and braced global together", () => {
        const template = "file: $ARGUMENTS[0], rest: ${ARGUMENTS}";
        expect(expandArguments(template, "a.txt b.txt")).toBe("file: a.txt, rest: a.txt b.txt");
    });
});
