import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("App session switching", () => {
  test("closes the docked artifact viewer before hydrating another session", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const openSession = source.slice(
      source.indexOf("const openSession = React.useCallback"),
      source.indexOf("const cached = sessionUiCacheRef.current.get", source.indexOf("const openSession = React.useCallback")),
    );

    expect(openSession).toContain("setArtifactViewer(null);");
  });
});
