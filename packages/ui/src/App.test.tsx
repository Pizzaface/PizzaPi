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

describe("runner event navigation", () => {
  test("does not expose the obsolete account-wide Events tab in runner detail", () => {
    const source = readFileSync(new URL("./components/RunnerDetailPanel.tsx", import.meta.url), "utf8");
    const tabs = source.slice(source.indexOf("const TABS:"), source.indexOf("function TabBar"));

    expect(tabs).not.toContain('key: "events"');
    expect(tabs).not.toContain("Events (account-wide)");
  });
});

describe("schedule manager navigation", () => {
  test("opens the trigger manager for the runner whose schedules are shown", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const modeHome = source.slice(source.indexOf("modeHome={selectedMode ?"), source.indexOf("scheduled: selectedModeUi.scheduled ?"));

    expect(modeHome).toContain("setSelectedRunnerId(scheduleRunnerId)");
    expect(modeHome).not.toContain("activeRunnerInfo?.runnerId");
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

describe("App.tsx wiring — native app resume forces a reconnect", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  // Isolate the effect that wires window/document reconnect listeners plus
  // the native resume listener, up to the matching `}, []);`.
  const effect = src.slice(
    src.indexOf("const kickSockets = () => {"),
    src.indexOf("// How long to ignore runner queue syncs"),
  );

  test("registerAppResumeListener is wired, not left unused", () => {
    expect(effect).toMatch(/registerAppResumeListener\(/);
  });

  test("native resume does NOT reuse kickSockets (the visibilityState-gated web path)", () => {
    const resumeCall = effect.match(/registerAppResumeListener\((\w+)\)/);
    expect(resumeCall).not.toBeNull();
    expect(resumeCall![1]).not.toBe("kickSockets");
  });

  test("the native resume handler does not gate on document.visibilityState", () => {
    const resumeCall = effect.match(/registerAppResumeListener\((\w+)\)/);
    const handlerName = resumeCall![1];
    const handlerBody = effect.slice(
      effect.indexOf(`const ${handlerName} = () => {`),
      effect.indexOf(`registerAppResumeListener(${handlerName})`),
    );
    expect(handlerBody).not.toMatch(/visibilityState/);
  });

  test("the native resume handler only force-disconnects+reconnects when the connection could plausibly be stale", () => {
    const resumeCall = effect.match(/registerAppResumeListener\((\w+)\)/);
    const handlerName = resumeCall![1];
    const handlerBody = effect.slice(
      effect.indexOf(`const ${handlerName} = () => {`),
      effect.indexOf(`registerAppResumeListener(${handlerName})`),
    );
    // Must consult shouldForceReconnectOnResume rather than unconditionally
    // tearing down a healthy socket (see viewer-connection.test.ts for the
    // pure-function behavior), but still be ABLE to disconnect()+connect()
    // a genuinely stale one.
    expect(handlerBody).toMatch(/shouldForceReconnectOnResume\(/);
    expect(handlerBody).toMatch(/viewer\.disconnect\(\)/);
    expect(handlerBody).toMatch(/viewer\.connect\(\)/);
    expect(handlerBody).toMatch(/hub\.disconnect\(\)/);
    expect(handlerBody).toMatch(/hub\.connect\(\)/);
  });

  test("the native resume handler is debounced against bursts of appStateChange events", () => {
    const resumeCall = effect.match(/registerAppResumeListener\((\w+)\)/);
    const handlerName = resumeCall![1];
    const handlerBody = effect.slice(
      effect.indexOf(`const ${handlerName} = () => {`),
      effect.indexOf(`registerAppResumeListener(${handlerName})`),
    );
    expect(handlerBody).toMatch(/APP_RESUME_DEBOUNCE_MS/);
  });
});

describe("App.tsx wiring — stale-connection watchdog backs off instead of looping", () => {
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  test("the watchdog interval consults the backoff-aware trigger function", () => {
    const watchdog = src.slice(
      src.indexOf("staleCheckTimerRef.current = setInterval"),
      src.indexOf("}, STALE_CHECK_INTERVAL_MS);"),
    );
    expect(watchdog).toMatch(/shouldTriggerStaleWatchdogReconnect\(/);
    expect(watchdog).toMatch(/consecutiveStaleReconnectsRef\.current \+= 1/);
  });

  test("a liveness-only heartbeat replay does not reset the backoff counter", () => {
    const eventHandler = src.slice(
      src.indexOf('nextSocket.on("event", (data) => {'),
      src.indexOf('nextSocket.on("session_messages_page"'),
    );
    expect(eventHandler).toMatch(/isLivenessOnlyHeartbeat/);
    expect(eventHandler).toMatch(/_livenessOnly/);
    expect(eventHandler).toMatch(/if \(!isLivenessOnlyHeartbeat\) consecutiveStaleReconnectsRef\.current = 0;/);
  });

  test("a real exec_result resets the backoff counter", () => {
    const execResultHandler = src.slice(
      src.indexOf('nextSocket.on("exec_result"'),
      src.indexOf('nextSocket.on("disconnected"'),
    );
    expect(execResultHandler).toMatch(/consecutiveStaleReconnectsRef\.current = 0;/);
  });
});
