import { describe, expect, test } from "bun:test";
import { repoRelativePath } from "./utils";

describe("repoRelativePath", () => {
  test("strips cwd prefix", () => {
    expect(repoRelativePath("/repo", "/repo/src/foo.ts")).toBe("src/foo.ts");
  });

  test("handles cwd with trailing slash", () => {
    expect(repoRelativePath("/repo/", "/repo/src/foo.ts")).toBe("src/foo.ts");
  });

  test("returns the original path when already relative", () => {
    expect(repoRelativePath("/repo", "src/foo.ts")).toBe("src/foo.ts");
  });

  test("returns empty string when filePath equals cwd", () => {
    expect(repoRelativePath("/repo", "/repo")).toBe("");
  });
});
