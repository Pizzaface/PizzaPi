import { describe, test, expect } from "bun:test";
import { resolveFilePath, repoRelativePath } from "./utils";

describe("resolveFilePath", () => {
  test("POSIX absolute passes through", () => {
    expect(resolveFilePath("/home/j/proj", "/etc/hosts")).toBe("/etc/hosts");
  });

  test("POSIX relative joins with cwd", () => {
    expect(resolveFilePath("/home/j/proj/", "src/app.ts")).toBe("/home/j/proj/src/app.ts");
  });

  test("Windows drive absolute passes through (both slash styles)", () => {
    expect(resolveFilePath("C:\\proj", "C:\\Users\\j\\a.ts")).toBe("C:\\Users\\j\\a.ts");
    expect(resolveFilePath("C:\\proj", "D:/data/b.ts")).toBe("D:/data/b.ts");
  });

  test("UNC absolute passes through", () => {
    expect(resolveFilePath("C:\\proj", "\\\\server\\share\\f.ts")).toBe("\\\\server\\share\\f.ts");
  });

  test("relative joins with Windows cwd using backslash", () => {
    expect(resolveFilePath("C:\\Users\\j\\proj\\", "src/app.ts")).toBe("C:\\Users\\j\\proj\\src/app.ts");
  });
});

describe("repoRelativePath (Windows)", () => {
  test("strips Windows cwd prefix", () => {
    expect(repoRelativePath("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src\\a.ts");
  });

  test("still strips POSIX cwd prefix", () => {
    expect(repoRelativePath("/home/j/proj", "/home/j/proj/src/a.ts")).toBe("src/a.ts");
  });
});
