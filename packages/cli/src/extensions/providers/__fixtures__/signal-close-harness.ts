/**
 * Test fixture: simulates the worker's shutdown wiring for provider
 * onSessionClose (see runner/worker.ts `shutdown()`).
 *
 * Spawned as a subprocess by session-close-signal.test.ts. Installs a
 * SIGTERM handler that runs runProviderSessionClose — the same in-process
 * close path the worker uses — with a provider that writes a marker file.
 * The parent test SIGTERMs this process and asserts the marker exists,
 * proving the close hook fires across a real process/signal boundary
 * (regression for the daemon-side cross-process no-op, idea jg017xa4).
 */
import { writeFileSync } from "node:fs";
import { runProviderSessionClose, __setBridgeForTest } from "../extension";
import { ProviderBridge } from "../../../providers/bridge";

const markerPath = process.env.CLOSE_MARKER_PATH;
if (!markerPath) {
  console.error("CLOSE_MARKER_PATH not set");
  process.exit(1);
}

const provider = {
  id: "signal-close-fixture",
  capabilities: ["lifecycle"],
  init: async () => {},
  dispose: () => {},
  onSessionClose: async (event: { reason: string }) => {
    writeFileSync(markerPath, JSON.stringify({ reason: event.reason }));
    return { label: "fixture-archived" };
  },
};

__setBridgeForTest(new ProviderBridge([provider as any]));

process.on("SIGTERM", () => {
  void runProviderSessionClose("close")
    .catch(() => {})
    .finally(() => process.exit(0));
});

// Signal readiness and stay alive until SIGTERM.
console.log("ready");
setInterval(() => {}, 1_000);
