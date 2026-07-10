import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Integration-style wiring tests for the runtime payload guards in App.tsx.
 *
 * These tests verify that the protocol-level decoders are wired at the first
 * external boundary (viewer socket, hub socket, and HTTP spawn response) so
 * malformed payloads are caught before they can mutate session state.
 */

describe("App payload validation wiring", () => {
  const sourceText = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const lifecycleSourceText = readFileSync(new URL("./lib/use-session-lifecycle.ts", import.meta.url), "utf8");

  test("imports the protocol decoders", () => {
    expect(sourceText).toMatch(/parseViewerEventEnvelope/);
    expect(sourceText).toMatch(/parseViewerConnectedEnvelope/);
    expect(sourceText).toMatch(/parseHubStateSnapshot/);
    expect(sourceText).toMatch(/parseHubMetaEvent/);
    expect(sourceText).toMatch(/parseSpawnResponse/);
  });

  test("validates viewer event envelope before using generation or event", () => {
    expect(sourceText).toMatch(/parseViewerEventEnvelope\(data\)/);
    expect(sourceText).toMatch(/logFrontendEvent\("viewer", "warning", "Malformed viewer event envelope"/);
  });

  test("validates viewer connected envelope before reading sessionId", () => {
    expect(sourceText).toMatch(/parseViewerConnectedEnvelope\(data\)/);
    expect(sourceText).toMatch(/logFrontendEvent\("viewer", "warning", "Malformed viewer connected envelope"/);
  });

  test("validates hub state snapshot before applying meta state", () => {
    expect(sourceText).toMatch(/parseHubStateSnapshot\(raw\)/);
    expect(sourceText).toMatch(/logFrontendEvent\("hub", "warning", "Malformed state snapshot"/);
  });

  test("validates hub meta event before calling metaEventToStatePatch", () => {
    expect(sourceText).toMatch(/parseHubMetaEvent\(raw\)/);
    expect(sourceText).toMatch(/logFrontendEvent\("hub", "warning", "Malformed meta event"/);
  });

  test("validates spawn HTTP responses before opening sessions", () => {
    const combinedSource = sourceText + lifecycleSourceText;
    const spawnCalls = combinedSource.match(/fetch\("\/api\/runners\/spawn"/g) ?? [];
    const parseCalls = combinedSource.match(/parseSpawnResponse\(body\)/g) ?? [];
    expect(parseCalls.length).toBe(spawnCalls.length);
  });
});
