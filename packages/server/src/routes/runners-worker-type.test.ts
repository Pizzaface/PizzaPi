import { test, expect } from "bun:test";
import { normaliseWorkerType } from "./runners.js";

test("defaults to pi when absent", () => {
  expect(normaliseWorkerType(undefined)).toBe("pi");
});

test("accepts claude-code", () => {
  expect(normaliseWorkerType("claude-code")).toBe("claude-code");
});

test("defaults to pi for unknown string", () => {
  expect(normaliseWorkerType("banana")).toBe("pi");
});

test("defaults to pi for pi (redundant but explicit)", () => {
  expect(normaliseWorkerType("pi")).toBe("pi");
});
