import { describe, expect, it } from "bun:test";
import { isValidSkillName } from "../src/validation.js";

describe("isValidSkillName", () => {
    it("should accept valid skill names", () => {
        expect(isValidSkillName("my-skill")).toBe(true);
        expect(isValidSkillName("my_skill")).toBe(true);
        expect(isValidSkillName("Skill123")).toBe(true);
        expect(isValidSkillName("a")).toBe(true);
        expect(isValidSkillName("123")).toBe(true);
        expect(isValidSkillName("script.py")).toBe(true);
        expect(isValidSkillName("my.cool.script")).toBe(true);
    });

    it("should reject invalid characters", () => {
        expect(isValidSkillName("my skill")).toBe(false); // space
        expect(isValidSkillName("my/skill")).toBe(false); // slash
        expect(isValidSkillName("my\\skill")).toBe(false); // backslash
        expect(isValidSkillName("skill!")).toBe(false); // special char
        expect(isValidSkillName("../skill")).toBe(false); // path traversal
    });

    it("should reject invalid dot usage", () => {
        expect(isValidSkillName(".config")).toBe(false); // starts with dot
        expect(isValidSkillName("config.")).toBe(false); // ends with dot
        expect(isValidSkillName("foo..bar")).toBe(false); // consecutive dots
        expect(isValidSkillName("..")).toBe(false); // just dots
    });

    it("should reject names that are too long", () => {
        const longName = "a".repeat(65);
        expect(isValidSkillName(longName)).toBe(false);
        const maxLengthName = "a".repeat(64);
        expect(isValidSkillName(maxLengthName)).toBe(true);
    });

    it("should reject empty or non-string inputs", () => {
        expect(isValidSkillName("")).toBe(false);
        // @ts-ignore
        expect(isValidSkillName(null)).toBe(false);
        // @ts-ignore
        expect(isValidSkillName(undefined)).toBe(false);
        // @ts-ignore
        expect(isValidSkillName(123)).toBe(false);
    });
});
