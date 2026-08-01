/**
 * Cross-process regression test for provider onSessionClose (idea jg017xa4).
 *
 * The historical bug: the daemon imported triggerSessionClose and called it
 * in its own process, where the module-global provider bridge is never
 * initialized — a guaranteed no-op. The fix runs close inside the worker's
 * own shutdown paths. This test proves the close hook actually fires across
 * a real process + signal boundary: it spawns a subprocess wired exactly
 * like the worker's SIGTERM path and asserts the provider's onSessionClose
 * side effect materialized after SIGTERM.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "__fixtures__", "signal-close-harness.ts");

describe("provider onSessionClose across process boundary", () => {
  test("SIGTERM to the worker-like process runs provider close before exit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "session-close-signal-"));
    const markerPath = join(tmp, "close-marker.json");
    try {
      const proc = Bun.spawn(["bun", FIXTURE], {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          CLOSE_MARKER_PATH: markerPath,
          HOME: tmp, // isolate from any real ~/.pizzapi config
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait for the harness to signal readiness (bounded).
      const reader = proc.stdout.getReader();
      const deadline = Date.now() + 15_000;
      let ready = false;
      let buffered = "";
      while (!ready && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += new TextDecoder().decode(value);
        if (buffered.includes("ready")) ready = true;
      }
      expect(ready).toBe(true);

      proc.kill("SIGTERM");
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      expect(marker.reason).toBe("close");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
