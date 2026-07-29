import { describe, test, expect } from "bun:test";
import { parsePizzaPiUrl } from "./PizzaPiNavContext";

describe("parsePizzaPiUrl file URLs", () => {
  test("round-trips an encoded absolute path as a single segment", () => {
    const path = "/Users/jordan/Documents/Projects/PizzaPi/README.md";
    const url = `pizzapi://file/${encodeURIComponent(path)}`;
    const parsed = parsePizzaPiUrl(url);
    expect(parsed).not.toBeNull();
    const segments = parsed!.path.split("/").filter(Boolean);
    expect(segments[0]).toBe("file");
    expect(decodeURIComponent(segments.slice(1).join("/"))).toBe(path);
  });

  test("round-trips a relative path", () => {
    const path = "packages/ui/src/App.tsx";
    const parsed = parsePizzaPiUrl(`pizzapi://file/${encodeURIComponent(path)}`);
    const segments = parsed!.path.split("/").filter(Boolean);
    expect(decodeURIComponent(segments.slice(1).join("/"))).toBe(path);
  });

  test("rejects non-pizzapi URLs", () => {
    expect(parsePizzaPiUrl("https://example.com")).toBeNull();
  });
});
