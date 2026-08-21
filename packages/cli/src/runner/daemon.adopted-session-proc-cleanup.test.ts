import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A1): adopted-session process registry cleanup.
 *
 * When the daemon restarts (exit 42) it re-adopts sessions whose workers stayed
 * alive. Those sessions are tracked with `child: null`, so `session-spawner.ts`
 * never installs a `child.on("exit")` handler for them. The only teardown path
 * left is the `session_ended` handler in `daemon.ts`.
 *
 * For a spawned session, `child.on("exit")` kills the worker process group, kills
 * every recorded bash-command group from `~/.pizzapi/session-procs/{id}.pids`,
 * and deletes the pid file via `removeSessionProcFile`. For adopted sessions,
 * `session_ended` only runs service cleanup and `cleanupSessionAttachments`; it
 * never reaps recorded process groups or removes the registry file. Backgrounded
 * bash commands and other recorded groups can therefore outlive the session.
 *
 * This is distinct from restart cleanup in `session-spawner.ts` and from the
 * missing SIGKILL escalation on a spawned session's natural exit.
 */
describe("daemon session_ended reaps adopted session process groups", () => {
    const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

    test("session_ended handler contains process-registry cleanup", () => {
        const start = source.indexOf('socket.on("session_ended"');
        expect(start).toBeGreaterThan(-1);

        const end = source.indexOf('socket.on("list_sessions"', start);
        expect(end).toBeGreaterThan(start);

        const block = source.slice(start, end);

        // A correct teardown must remove the recorded-group pid file for the
        // session and reap any groups it recorded.
        expect(block).toMatch(/removeSessionProcFile\s*\(\s*sessionId\s*\)/);
        expect(block).toMatch(/readRecordedGroupPids\s*\(/);
        expect(block).toMatch(/killSessionProcessGroup\s*\(/);
    });
});
