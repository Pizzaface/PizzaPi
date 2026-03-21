import { describe, expect, test } from "bun:test";
import {
  PASSWORD_REQUIREMENTS,
  PASSWORD_REQUIREMENTS_SUMMARY,
  validatePassword,
  isValidPassword,
} from "./index";

// ---------------------------------------------------------------------------
// index.ts public API surface — verify all runtime exports are present
// ---------------------------------------------------------------------------

describe("index — runtime exports", () => {
  test("PASSWORD_REQUIREMENTS is exported and is a readonly tuple of 4 strings", () => {
    expect(Array.isArray(PASSWORD_REQUIREMENTS)).toBe(true);
    expect(PASSWORD_REQUIREMENTS).toHaveLength(4);
    for (const req of PASSWORD_REQUIREMENTS) {
      expect(typeof req).toBe("string");
      expect(req.length).toBeGreaterThan(0);
    }
  });

  test("PASSWORD_REQUIREMENTS covers length, uppercase, lowercase, number", () => {
    const joined = PASSWORD_REQUIREMENTS.join(" ").toLowerCase();
    expect(joined).toContain("8");
    expect(joined).toContain("uppercase");
    expect(joined).toContain("lowercase");
    expect(joined).toContain("number");
  });

  test("PASSWORD_REQUIREMENTS_SUMMARY is a non-empty string", () => {
    expect(typeof PASSWORD_REQUIREMENTS_SUMMARY).toBe("string");
    expect(PASSWORD_REQUIREMENTS_SUMMARY.length).toBeGreaterThan(0);
  });

  test("PASSWORD_REQUIREMENTS_SUMMARY mentions key requirements", () => {
    const lower = PASSWORD_REQUIREMENTS_SUMMARY.toLowerCase();
    expect(lower).toContain("8");
    expect(lower).toContain("uppercase");
    expect(lower).toContain("lowercase");
    expect(lower).toContain("number");
  });

  test("validatePassword is a function", () => {
    expect(typeof validatePassword).toBe("function");
  });

  test("isValidPassword is a function", () => {
    expect(typeof isValidPassword).toBe("function");
  });

  test("validatePassword returns the expected PasswordCheck shape", () => {
    const result = validatePassword("Valid1Pass");
    expect(typeof result.valid).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks).toHaveLength(4);
    for (const check of result.checks) {
      expect(typeof check.label).toBe("string");
      expect(typeof check.met).toBe("boolean");
    }
  });

  test("isValidPassword returns boolean", () => {
    expect(typeof isValidPassword("Valid1Pass")).toBe("boolean");
    expect(typeof isValidPassword("bad")).toBe("boolean");
  });

  test("isValidPassword and validatePassword are consistent", () => {
    const passwords = ["Valid1Pass", "short", "NOLOWER1", "noupper1", "NoNumbers", ""];
    for (const pw of passwords) {
      expect(isValidPassword(pw)).toBe(validatePassword(pw).valid);
    }
  });
});
