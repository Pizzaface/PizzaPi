import { describe, expect, test } from "bun:test";
import { applyDeferLoadingMode, deferLoadingValueToMode } from "./mcp-server-defer-loading";

describe("mcp server defer loading helpers", () => {
  test("maps raw config values to UI modes", () => {
    expect(deferLoadingValueToMode(undefined)).toBe("inherit");
    expect(deferLoadingValueToMode(true)).toBe("always");
    expect(deferLoadingValueToMode(false)).toBe("never");
  });

  test("inherit removes deferLoading while preserving other fields", () => {
    const result = applyDeferLoadingMode(
      { command: "npx", args: ["foo"], deferLoading: true, disabled: false },
      "inherit",
    );
    expect(result).toEqual({ command: "npx", args: ["foo"], disabled: false });
    expect("deferLoading" in result).toBe(false);
  });

  test("always writes deferLoading true", () => {
    expect(applyDeferLoadingMode({ command: "npx" }, "always")).toEqual({
      command: "npx",
      deferLoading: true,
    });
  });

  test("never writes deferLoading false", () => {
    expect(applyDeferLoadingMode({ url: "http://localhost:3000/mcp" }, "never")).toEqual({
      url: "http://localhost:3000/mcp",
      deferLoading: false,
    });
  });
});
