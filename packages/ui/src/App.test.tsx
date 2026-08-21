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

describe("Tunnel service-message viewer switch guard", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("drops stale tunnel registrations after switching viewers and accepts the active viewer", () => {
    const handler = source.match(/const handler = \(envelope:[\s\S]*?viewerSocket\.on\("service_message", handler\);/)?.[0] ?? "";

    expect(handler).toMatch(/matchesViewerSession\(lifecycleRefs\.activeSessionId\.current, envelope\.sessionId\)/);
    expect(handler).toMatch(/matchesViewerGeneration\(lifecycleRefs\.generation\.current, envelope\.generation\)/);
    expect(handler).not.toMatch(/typeof envelope\.sessionId !== "string"/);
  });
});

describe("App.tsx wiring — matchesViewerSession applied to resync replay path", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("imports matchesViewerSession from viewer-switch", () => {
    expect(src).toMatch(/matchesViewerSession/);
  });

  test("reads sessionId from the viewer event envelope", () => {
    expect(src).toMatch(/sessionId.*envelopeSessionId|envelopeSessionId.*sessionId/);
  });

  test("calls matchesViewerSession before processing envelope events", () => {
    expect(src).toMatch(/matchesViewerSession\(.*activeSessionId.*envelopeSessionId/s);
  });
});
