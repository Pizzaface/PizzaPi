import { createAgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { defaultAgentDir, loadConfig } from "../config.js";

interface RunnerSession {
    sessionId: string;
    agentSession: Awaited<ReturnType<typeof createAgentSession>>["session"];
    unsubscribe: () => void;
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
 * Authentication: bearer token via PIZZAPI_RUNNER_TOKEN env var (required).
 * Relay URL:      PIZZAPI_RELAY_URL env var (default: ws://localhost:3000).
 */
export async function runDaemon(_args: string[] = []): Promise<void> {
    const token = process.env.PIZZAPI_RUNNER_TOKEN;
    if (!token) {
        console.error("❌ PIZZAPI_RUNNER_TOKEN env var is required to run the runner daemon.");
        process.exit(1);
    }

    const relayBase = (process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3000").replace(/\/$/, "");
    const wsUrl = `${relayBase}/ws/runner`;

    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const agentDir = config.agentDir?.replace(/^~/, process.env.HOME ?? "") ?? defaultAgentDir();

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
            ws.send(JSON.stringify({ type: "register_runner" }));
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
                    try {
                        await spawnSession(ws, sessionId, cwd, agentDir, runningSessions);
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
                        entry.unsubscribe();
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

async function spawnSession(
    relayWs: WebSocket,
    sessionId: string,
    cwd: string,
    agentDir: string,
    runningSessions: Map<string, RunnerSession>,
): Promise<void> {
    console.log(`pizzapi runner: spawning session ${sessionId}…`);

    const { session } = await createAgentSession({ cwd, agentDir });

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
            relayWs.send(JSON.stringify({ type: "runner_session_event", sessionId, event }));
        } catch {}
    });

    runningSessions.set(sessionId, { sessionId, agentSession: session, unsubscribe });
    console.log(`pizzapi runner: session ${sessionId} ready`);
}
