import { expect, test, describe, mock, afterEach } from "bun:test";
import { join } from "node:path";

// Mock node:os before importing the module under test
const mockHomedir = mock(() => "/mock/home/dir");
mock.module("node:os", () => ({
  homedir: mockHomedir,
}));

// Import the module after mocking
import { getUsageDbPath, getSessionsDir } from "./schema.js";

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
