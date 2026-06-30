import { expect, test, describe, mock, afterEach, beforeAll } from "bun:test";
import { join } from "node:path";

// Mock node:os BEFORE importing the module under test.
// Static imports are hoisted and resolved before any top-level code runs,
// so we must register the mock here and use a dynamic import below.
const mockHomedir = mock(() => "/mock/home/dir");
mock.module("node:os", () => ({
  homedir: mockHomedir,
}));

let getUsageDbPath: typeof import("./schema.js").getUsageDbPath;
let getSessionsDir: typeof import("./schema.js").getSessionsDir;

beforeAll(async () => {
  ({ getUsageDbPath, getSessionsDir } = await import("./schema.js"));
});

describe("schema path functions", () => {
  afterEach(() => {
    mockHomedir.mockClear();
  });

  describe("getUsageDbPath", () => {
    test("returns correct path under homedir", () => {
      const expectedPath = join("/mock/home/dir", ".pizzapi", "usage.db");
      expect(getUsageDbPath()).toBe(expectedPath);
      expect(mockHomedir).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSessionsDir", () => {
    test("returns correct path under homedir", () => {
      const expectedPath = join("/mock/home/dir", ".pizzapi", "sessions");
      expect(getSessionsDir()).toBe(expectedPath);
      expect(mockHomedir).toHaveBeenCalledTimes(1);
    });
  });
});
