import { describe, expect, test } from "bun:test";
import { validatePassword, isValidPassword, MAX_PASSWORD_LENGTH, PASSWORD_REQUIREMENTS, PASSWORD_REQUIREMENTS_SUMMARY } from "./password";

describe("password validation constants", () => {
  test("MAX_PASSWORD_LENGTH is 128", () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
  });

  test("PASSWORD_REQUIREMENTS covers length, uppercase, lowercase, number", () => {
    expect(PASSWORD_REQUIREMENTS).toHaveLength(4);
    expect(PASSWORD_REQUIREMENTS[0]).toMatch(/8 characters/);
    expect(PASSWORD_REQUIREMENTS[1]).toMatch(/uppercase/);
    expect(PASSWORD_REQUIREMENTS[2]).toMatch(/lowercase/);
    expect(PASSWORD_REQUIREMENTS[3]).toMatch(/number/);
  });

  test("PASSWORD_REQUIREMENTS_SUMMARY is a string", () => {
    expect(typeof PASSWORD_REQUIREMENTS_SUMMARY).toBe("string");
    expect(PASSWORD_REQUIREMENTS_SUMMARY.length).toBeGreaterThan(0);
  });
});

describe("validatePassword", () => {
  test("accepts valid passwords", () => {
    const result = validatePassword("Abc12345");
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.met)).toBe(true);
  });

  test("accepts complex passwords", () => {
    expect(validatePassword("ComplexPass1").valid).toBe(true);
    expect(validatePassword("1234Abcd").valid).toBe(true);
    expect(validatePassword("P@ssw0rd!").valid).toBe(true);
  });

  test("accepts passwords exactly 8 characters long", () => {
    expect(validatePassword("Abcdefg1").valid).toBe(true);
    expect(validatePassword("1Bcdefgh").valid).toBe(true);
  });

  test("accepts passwords up to MAX_PASSWORD_LENGTH", () => {
    const longPassword = "A1a" + "b".repeat(125); // 128 chars total
    expect(validatePassword(longPassword).valid).toBe(true);
  });

  test("accepts passwords with spaces and emojis", () => {
    expect(validatePassword("Valid Pass 1! 🍕").valid).toBe(true);
  });

  test("rejects passwords shorter than 8 characters", () => {
    const result = validatePassword("Ab1cdef");
    expect(result.valid).toBe(false);
    expect(result.checks[0].met).toBe(false); // length
    expect(result.checks[0].label).toBe(PASSWORD_REQUIREMENTS[0]);
  });

  test("rejects empty string", () => {
    const result = validatePassword("");
    expect(result.valid).toBe(false);
    // Should fail length, uppercase, lowercase, and number
    expect(result.checks.filter((c) => c.met).length).toBe(0);
  });

  test("rejects string with only whitespace", () => {
    const result = validatePassword("        ");
    expect(result.valid).toBe(false);
    // Should fail uppercase, lowercase, and number
    expect(result.checks.filter((c) => c.met).length).toBe(1); // Length check is met
  });

  test("rejects passwords missing uppercase", () => {
    const result = validatePassword("abcdefg1");
    expect(result.valid).toBe(false);
    expect(result.checks[1].met).toBe(false); // uppercase
  });

  test("rejects passwords missing lowercase", () => {
    const result = validatePassword("ABCDEFG1");
    expect(result.valid).toBe(false);
    expect(result.checks[2].met).toBe(false); // lowercase
  });

  test("rejects passwords missing number", () => {
    const result = validatePassword("Abcdefgh");
    expect(result.valid).toBe(false);
    expect(result.checks[3].met).toBe(false); // number
  });

  test("returns invalid result for non-string inputs", () => {
    // Even though TS enforces string, runtime callers (JS, JSON deserialization)
    // may pass other types. The implementation guards and returns valid:false for
    // all non-string inputs rather than throwing, so callers don't need try/catch.
    expect(validatePassword(null as unknown as string).valid).toBe(false);
    expect(validatePassword(undefined as unknown as string).valid).toBe(false);
    // @ts-expect-error testing invalid type
    expect(validatePassword(12345678).valid).toBe(false);
  });

  test("returns 4 check items matching PASSWORD_REQUIREMENTS", () => {
    const result = validatePassword("anything");
    expect(result.checks.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(result.checks[i].label).toBe(PASSWORD_REQUIREMENTS[i]);
    }
  });
});

describe("isValidPassword", () => {
  test("returns true for valid passwords", () => {
    expect(isValidPassword("Abc12345")).toBe(true);
    expect(isValidPassword("ComplexPass1")).toBe(true);
  });

  test("returns false for invalid passwords", () => {
    expect(isValidPassword("short")).toBe(false);
    expect(isValidPassword("nouppercase1")).toBe(false);
    expect(isValidPassword("NOLOWERCASE1")).toBe(false);
    expect(isValidPassword("NoNumbers")).toBe(false);
    expect(isValidPassword("")).toBe(false);
  });

  test("returns false for non-string inputs", () => {
    // isValidPassword delegates to validatePassword, which returns valid:false
    // for all non-string inputs — no throws, consistent contract.
    expect(isValidPassword(null as unknown as string)).toBe(false);
    expect(isValidPassword(undefined as unknown as string)).toBe(false);
    // @ts-expect-error testing invalid type
    expect(isValidPassword(12345678)).toBe(false);
  });
});
