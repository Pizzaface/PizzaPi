import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane C): artifact viewer state bleeds across session switches.
 *
 * The artifact viewer panel holds a runner-specific path ({ path, kind, title }).
 * When the viewer switches to a different session, App.tsx's openSession() resets
 * messages, tool calls, pending UI, queues, analysis, etc., but it never calls
 * setArtifactViewer(null). The only place the state is cleared is on agent_end.
 *
 * Because the panel is keyed by activeSessionId, switching sessions leaves the
 * old artifact mounted and causes ArtifactViewerContent to fetch the previous
 * session's path against the new session's runnerId. That either fails to load or,
 * worse, renders the wrong file if a path collision exists on the new runner.
 */
describe("artifact viewer stale-state filtering on session switch", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("openSession resets artifact viewer before attaching to the new session", () => {
    const start = source.indexOf("const openSession = React.useCallback((relaySessionId: string) => {");
    const end = source.indexOf(
      "}, [handleRelayEvent, patchSessionCache, cancelPendingDeltas, lifecycleOpenSession",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toMatch(/setArtifactViewer\s*\(\s*null\s*\)/);
  });
});
