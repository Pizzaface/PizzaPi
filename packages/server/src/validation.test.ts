import { describe, expect, test } from "bun:test";
import { isValidSkillName } from "./validation";

describe("isValidSkillName", () => {
    test("accepts simple alphanumeric names", () => {
        expect(isValidSkillName("myskill")).toBe(true);
        expect(isValidSkillName("MySkill123")).toBe(true);
    });

    test("accepts names with dashes and underscores", () => {
        expect(isValidSkillName("my-skill")).toBe(true);
        expect(isValidSkillName("my_skill")).toBe(true);
        expect(isValidSkillName("a-b_c")).toBe(true);
    });

    test("accepts dotted names (namespaced)", () => {
        expect(isValidSkillName("org.skill")).toBe(true);
        expect(isValidSkillName("com.example.tool")).toBe(true);
    });

    test("rejects empty or non-string input", () => {
        expect(isValidSkillName("")).toBe(false);
        expect(isValidSkillName(null as any)).toBe(false);
        expect(isValidSkillName(undefined as any)).toBe(false);
        expect(isValidSkillName(123 as any)).toBe(false);
    });

    test("rejects names longer than 64 characters", () => {
        expect(isValidSkillName("a".repeat(64))).toBe(true);
        expect(isValidSkillName("a".repeat(65))).toBe(false);
    });

    test("rejects names starting or ending with a dot", () => {
        expect(isValidSkillName(".hidden")).toBe(false);
        expect(isValidSkillName("trailing.")).toBe(false);
    });

    test("rejects consecutive dots", () => {
        expect(isValidSkillName("a..b")).toBe(false);
        expect(isValidSkillName("a...b")).toBe(false);
    });

    test("rejects path traversal attempts", () => {
        expect(isValidSkillName("../etc/passwd")).toBe(false);
        expect(isValidSkillName("foo/bar")).toBe(false);
        expect(isValidSkillName("foo\\bar")).toBe(false);
    });

    test("rejects names with spaces or special characters", () => {
        expect(isValidSkillName("my skill")).toBe(false);
        expect(isValidSkillName("skill@v2")).toBe(false);
        expect(isValidSkillName("skill#1")).toBe(false);
        expect(isValidSkillName("skill!")).toBe(false);
    });
});
