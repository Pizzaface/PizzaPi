import { describe, expect, test } from "bun:test";
import { validatePassword, isValidPassword, PASSWORD_REQUIREMENTS } from "./password";

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
});
