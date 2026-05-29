import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("App session metadata updates", () => {
  test("reads the latest active model from a ref inside the relay event handler", () => {
    const path = new URL("./App.tsx", import.meta.url);
    const sourceText = readFileSync(path, "utf8");

    expect(sourceText).toMatch(/const activeModelRef = React\.useRef<ConfiguredModelInfo \| null>\(activeModel\);/);
    expect(sourceText).toMatch(/React\.useLayoutEffect\(\(\) => \{\s*activeModelRef\.current = activeModel;\s*\}, \[activeModel\]\);/s);
    expect(sourceText).toMatch(/currentActiveModel:\s*activeModelRef\.current/);
  });

  test("applies live analysis metadata to the active viewer state", () => {
    const path = new URL("./App.tsx", import.meta.url);
    const sourceText = readFileSync(path, "utf8");

    expect(sourceText).toMatch(/Object\.prototype\.hasOwnProperty\.call\(meta, "analysis"\)/);
    expect(sourceText).toMatch(/setAnalysis\(nextAnalysis \?\? null\)/);
    expect(sourceText).toMatch(/cachePatch\.analysis = nextAnalysis \?\? null/);
  });

  test("applies session_active analysis snapshots to viewer state and cache", () => {
    const path = new URL("./App.tsx", import.meta.url);
    const sourceText = readFileSync(path, "utf8");

    expect(sourceText).toMatch(/Object\.prototype\.hasOwnProperty\.call\(state, "analysis"\)/);
    expect(sourceText).toMatch(/setAnalysis\(stateAnalysis \?\? null\)/);
    expect(sourceText).toMatch(/\.\.\.\(hasStateAnalysis \? \{ analysis: stateAnalysis \?\? null \} : \{\}\)/);
  });
});
