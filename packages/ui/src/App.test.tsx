import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Tunnel service-message viewer switch guard", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("drops stale tunnel registrations after switching viewers and accepts the active viewer", () => {
    const handler = source.match(/const handler = \(envelope:[\s\S]*?viewerSocket\.on\("service_message", handler\);/)?.[0] ?? "";

    expect(handler).toMatch(/matchesViewerSession\(lifecycleRefs\.activeSessionId\.current, envelope\.sessionId\)/);
    expect(handler).toMatch(/matchesViewerGeneration\(lifecycleRefs\.generation\.current, envelope\.generation\)/);
    expect(handler).not.toMatch(/typeof envelope\.sessionId !== "string"/);
  });
});
