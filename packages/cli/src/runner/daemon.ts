import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface RunnerSession {
    sessionId: string;
    child: ChildProcess;
    startedAt: number;
}

/**
 * Remote Runner daemon.
 *
 * Connects to the PizzaPi relay server over WebSocket and registers itself as
 * an available runner. The relay server (and through it the web UI) can then:
 *
 *   - Request a new agent session be spawned  (new_session)
 *   - List active sessions                    (list_sessions)
 *   - Kill a session                          (kill_session)
 *
 * Authentication: API key via PIZZAPI_API_KEY env var (required).
 *                (Back-compat: PIZZAPI_RUNNER_TOKEN server token)
 * Relay URL:      PIZZAPI_RELAY_URL env var (default: ws://localhost:3000).
 */
export async function runDaemon(_args: string[] = []): Promise<void> {
    // Enforce one runner per machine via a lock file.
    // This prevents multiple runner daemons on the same host from fighting over sessions.
    const lockPath = process.env.PIZZAPI_RUNNER_LOCK_PATH ?? join(tmpdir(), "pizzapi-runner.lock");
    const lockOwned = acquireRunnerLock(lockPath);

    const apiKey = process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY;
    const token = process.env.PIZZAPI_RUNNER_TOKEN;

    if (!apiKey && !token) {
        console.error("❌ Set PIZZAPI_API_KEY (recommended) or PIZZAPI_RUNNER_TOKEN to run the runner daemon.");
        if (lockOwned) releaseRunnerLock(lockPath);
        process.exit(1);
    }

    const shutdown = (code: number) => {
        if (lockOwned) releaseRunnerLock(lockPath);
        process.exit(code);
    };

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("exit", () => {
        if (lockOwned) releaseRunnerLock(lockPath);
    });

    const relayBase = (process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3000").replace(/\/$/, "");
    const wsUrl = `${relayBase}/ws/runner`;

    const runningSessions = new Map<string, RunnerSession>();

    console.log(`pizzapi runner: connecting to relay at ${wsUrl}…`);
    connect();

    function connect() {
        const ws = new WebSocket(wsUrl, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        } as any);
        let runnerId: string | null = null;
        let reconnectDelay = 1000;

        ws.onopen = () => {
            console.log("pizzapi runner: connected. Registering…");
            ws.send(
                JSON.stringify({
                    type: "register_runner",
                    name: process.env.PIZZAPI_RUNNER_NAME ?? null,
                    roots: getWorkspaceRoots(),
                }),
            );
            reconnectDelay = 1000;
        };

        ws.onmessage = async (evt) => {
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(evt.data as string);
            } catch {
                return;
            }

            switch (msg.type) {
                case "runner_registered": {
                    runnerId = msg.runnerId as string;
                    console.log(`pizzapi runner: registered as ${runnerId}`);
                    break;
                }

                case "new_session": {
                    const sessionId = msg.sessionId as string;
                    const requestedCwd = typeof msg.cwd === "string" ? msg.cwd : undefined;

                    if (!sessionId) {
                        ws.send(
                            JSON.stringify({
                                type: "session_error",
                                runnerId,
                                sessionId,
                                message: "Missing sessionId",
                            }),
                        );
                        break;
                    }

                    // The worker uses the runner's API key to register with /ws/sessions.
                    if (!apiKey) {
                        ws.send(
                            JSON.stringify({
                                type: "session_error",
                                runnerId,
                                sessionId,
                                message: "Runner is missing PIZZAPI_API_KEY",
                            }),
                        );
                        break;
                    }

                    try {
                        spawnSession(sessionId, apiKey, requestedCwd, runningSessions);
                        ws.send(JSON.stringify({ type: "session_ready", runnerId, sessionId }));
                    } catch (err) {
                        ws.send(
                            JSON.stringify({
                                type: "session_error",
                                runnerId,
                                sessionId,
                                message: err instanceof Error ? err.message : String(err),
                            }),
                        );
                    }
                    break;
                }

                case "kill_session": {
                    const sessionId = msg.sessionId as string;
                    const entry = runningSessions.get(sessionId);
                    if (entry) {
                        try {
                            entry.child.kill("SIGTERM");
                        } catch {}
                        runningSessions.delete(sessionId);
                        console.log(`pizzapi runner: killed session ${sessionId}`);
                        ws.send(JSON.stringify({ type: "session_killed", runnerId, sessionId }));
                    }
                    break;
                }

                case "list_sessions": {
                    ws.send(
                        JSON.stringify({
                            type: "sessions_list",
                            runnerId,
                            sessions: Array.from(runningSessions.keys()),
                        }),
                    );
                    break;
                }

                case "ping": {
                    ws.send(JSON.stringify({ type: "pong", runnerId, now: Date.now() }));
                    break;
                }
            }
        };

        ws.onerror = () => {
            // error will be followed by close, which handles reconnect
        };

        ws.onclose = () => {
            console.log(`pizzapi runner: disconnected. Reconnecting in ${reconnectDelay / 1000}s…`);
            setTimeout(() => {
                reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
                connect();
            }, reconnectDelay);
        };
    }
}

function isPidRunning(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        // ESRCH = process does not exist. EPERM = exists but no permission.
        if (err?.code === "ESRCH") return false;
        return true;
    }
}

function acquireRunnerLock(lockPath: string): boolean {
    // Try once; if stale lock, clean and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, "wx");
            try {
                writeFileSync(
                    fd,
                    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
                    { encoding: "utf-8" },
                );
            } finally {
                closeSync(fd);
            }
            return true;
        } catch (err: any) {
            if (err?.code !== "EEXIST") {
                console.error(`❌ Failed to acquire runner lock at ${lockPath}: ${err?.message ?? String(err)}`);
                process.exit(1);
            }

            // Existing lock: check if it's stale.
            try {
                const raw = readFileSync(lockPath, "utf-8");
                const parsed = JSON.parse(raw) as { pid?: number };
                const pid = typeof parsed?.pid === "number" ? parsed.pid : NaN;
                if (!isPidRunning(pid)) {
                    // stale
                    unlinkSync(lockPath);
                    continue;
                }
            } catch {
                // If lock file is unreadable/corrupt, be conservative: treat as held.
            }

            console.error(`❌ pizzapi runner already running (lock: ${lockPath}).`);
            console.error("   Stop the existing runner process or delete the lock if it is stale.");
            process.exit(1);
        }
    }
    return false;
}

function releaseRunnerLock(lockPath: string) {
    try {
        unlinkSync(lockPath);
    } catch {
        // ignore
    }
}

function parseRoots(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\\/g, "/"))
        .map((s) => (s.length > 1 ? s.replace(/\/+$/, "") : s));
}

function getWorkspaceRoots(): string[] {
    // Preferred env vars
    const rootsRaw = process.env.PIZZAPI_WORKSPACE_ROOTS;
    const rootSingle = process.env.PIZZAPI_WORKSPACE_ROOT;

    // Back-compat
    const legacy = process.env.PIZZAPI_RUNNER_ROOTS;

    if (rootsRaw && rootsRaw.trim()) return parseRoots(rootsRaw);
    if (rootSingle && rootSingle.trim()) return parseRoots(rootSingle);
    if (legacy && legacy.trim()) return parseRoots(legacy);
    return [];
}

function isCwdAllowed(cwd: string | undefined): boolean {
    if (!cwd) return true;
    const roots = getWorkspaceRoots();
    if (roots.length === 0) return true; // unscoped runner
    const nCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    return roots.some((root) => nCwd === root || nCwd.startsWith(root + "/"));
}

function spawnSession(
    sessionId: string,
    apiKey: string,
    requestedCwd: string | undefined,
    runningSessions: Map<string, RunnerSession>,
): void {
    console.log(`pizzapi runner: spawning headless worker for session ${sessionId}…`);

    if (runningSessions.has(sessionId)) {
        throw new Error(`Session already running: ${sessionId}`);
    }

    if (!isCwdAllowed(requestedCwd)) {
        throw new Error(`Requested cwd is outside allowed workspace root(s): ${requestedCwd}`);
    }

    if (requestedCwd) {
        if (!existsSync(requestedCwd)) {
            throw new Error(`cwd does not exist: ${requestedCwd}`);
        }
        const st = statSync(requestedCwd);
        if (!st.isDirectory()) {
            throw new Error(`cwd is not a directory: ${requestedCwd}`);
        }
    }

    const workerPath = resolveWorkerEntryPoint();

    const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as any,
        // Ensure relay URL is present for the remote extension in the worker.
        PIZZAPI_RELAY_URL: process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3000",
        PIZZAPI_API_KEY: apiKey,
        PIZZAPI_SESSION_ID: sessionId,
        ...(requestedCwd ? { PIZZAPI_WORKER_CWD: requestedCwd } : {}),
    };

    const child = spawn(process.execPath, [workerPath], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("exit", (code, signal) => {
        runningSessions.delete(sessionId);
        console.log(`pizzapi runner: session ${sessionId} exited (code=${code}, signal=${signal})`);
    });

    runningSessions.set(sessionId, { sessionId, child, startedAt: Date.now() });
    console.log(`pizzapi runner: session ${sessionId} worker spawned (pid=${child.pid})`);
}

function resolveWorkerEntryPoint(): string {
    // When running from TS sources via `bun`, import.meta.url ends with .ts.
    // When running from built output, it ends with .js.
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${ext}`, import.meta.url);
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
        // Fallback: try the other extension.
        const altExt = ext === "ts" ? "js" : "ts";
        const alt = fileURLToPath(new URL(`./worker.${altExt}`, import.meta.url));
        if (existsSync(alt)) return alt;
        throw new Error(`Runner worker entrypoint not found: ${path}`);
    }
    return path;
}
