/**
 * Cross-process test for worker pre-exit shutdown hooks.
 *
 * pi's `session_shutdown` is awaited but only fires for in-app transitions
 * (quit/reload/new/resume/fork) — it does NOT fire when the daemon SIGTERMs a
 * worker. The worker's own signal handler is the injection point, so the
 * capability is only proven by crossing a real process + signal boundary.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "__fixtures__", "shutdown-hook-signal-harness.ts");

describe("worker shutdown hooks across a process boundary", () => {
    test("SIGTERM to the worker-like process runs registered hooks before exit", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "shutdown-hook-signal-"));
        const markerPath = join(tmp, "close-marker.json");
        try {
            const proc = Bun.spawn(["bun", FIXTURE], {
                cwd: import.meta.dir,
                env: {
                    ...process.env,
                    CLOSE_MARKER_PATH: markerPath,
                    HOME: tmp, // isolate from any real ~/.pizzapi config
                    PIZZAPI_SESSION_ID: "sess-fixture",
                },
                stdout: "pipe",
                stderr: "pipe",
            });

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
            // The hook sleeps before writing, so a marker here also proves the
            // shutdown path awaited it instead of exiting mid-flush.
            expect(existsSync(markerPath)).toBe(true);
            const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
            expect(marker.reason).toBe("close");
            expect(marker.sessionId).toBe("sess-fixture");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }, 30_000);
});
