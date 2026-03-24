/**
 * Mock runner client for integration tests.
 *
 * Connects to a test server's /runner Socket.IO namespace and mimics the
 * behaviour of a real PizzaPi runner daemon.
 */

import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { randomUUID } from "crypto";

import type {
    RunnerSkill,
    RunnerAgent,
    RunnerPlugin,
    RunnerHook,
} from "@pizzapi/protocol";

import type { TestServer } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MockRunnerOptions {
    /** Override the API key used for auth (default: server.apiKey). Pass a bad key to test auth failures. */
    apiKey?: string;
    runnerId?: string;
    name?: string;
    roots?: string[];
    skills?: RunnerSkill[];
    agents?: RunnerAgent[];
    plugins?: RunnerPlugin[];
    hooks?: RunnerHook[];
    version?: string;
    platform?: string;
}

export interface MockRunner {
    runnerId: string;
    socket: ClientSocket;

    // Session lifecycle helpers
    emitSessionReady(sessionId: string): void;
    emitSessionError(sessionId: string, error: string): void;
    emitSessionEvent(sessionId: string, event: unknown): void;
    emitSessionEnded(sessionId: string): void;

    // Request handler registration
    onSkillRequest(handler: (data: unknown) => unknown): void;
    onFileRequest(handler: (data: unknown) => unknown): void;

    // Utilities
    waitForEvent(eventName: string, timeout?: number): Promise<unknown>;
    disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock runner that connects to the given test server's /runner
 * namespace, registers itself, and returns a helper object for emitting
 * events in tests.
 */
export async function createMockRunner(
    server: TestServer,
    opts?: MockRunnerOptions,
): Promise<MockRunner> {
    const runnerId = opts?.runnerId ?? randomUUID();

    const socket: ClientSocket = ioClient(`${server.baseUrl}/runner`, {
        auth: { apiKey: opts?.apiKey ?? server.apiKey },
        transports: ["websocket"],
        // Prevent socket.io from trying to upgrade / reconnect in tests
        reconnection: false,
        forceNew: true,
    });

    // Wait for the socket to connect and the server to confirm registration.
    // The server generates its own runnerId (ignoring the client-side hint unless
    // runnerSecret is also provided), so we capture the actual ID from runner_registered.
    let assignedRunnerId = runnerId; // fallback; replaced below
    await new Promise<void>((resolve, reject) => {
        // Guard against double-settling (timeout + normal path racing).
        let settled = false;

        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(registrationTimer);
            fn();
        };

        // P3: Explicit registration timeout — reject if the server never responds.
        const registrationTimer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.disconnect();
                reject(new Error("Mock runner registration timed out after 5000ms"));
            }
        }, 5_000);

        const connectErrorHandler = (err: Error) => {
            settle(() => reject(new Error(`Mock runner connect_error: ${err.message}`)));
        };

        socket.on("connect_error", connectErrorHandler);

        socket.on("connect", () => {
            // Emit registration payload
            socket.emit("register_runner", {
                runnerId,
                name: opts?.name ?? "test-runner",
                roots: opts?.roots ?? ["/tmp/test"],
                skills: opts?.skills ?? [],
                agents: opts?.agents ?? [],
                plugins: opts?.plugins ?? [],
                hooks: opts?.hooks ?? [],
                version: opts?.version ?? "1.0.0-test",
                platform: opts?.platform ?? "linux",
            });
        });

        socket.once("runner_registered", (data: { runnerId: string }) => {
            settle(() => {
                // Use the server-assigned runnerId (server may have generated a new one)
                assignedRunnerId = data.runnerId;
                resolve();
            });
        });

        // Reject fast on explicit error events from the server
        socket.once("error", (data: { message: string }) => {
            settle(() => reject(new Error(`Server error during registration: ${data.message}`)));
        });
    });

    // ── MockRunner implementation ──────────────────────────────────────────

    const runner: MockRunner = {
        runnerId: assignedRunnerId,
        socket,

        emitSessionReady(sessionId: string): void {
            socket.emit("session_ready", { sessionId });
        },

        emitSessionError(sessionId: string, error: string): void {
            socket.emit("session_error", { sessionId, message: error });
        },

        emitSessionEvent(sessionId: string, event: unknown): void {
            socket.emit("runner_session_event", { sessionId, event });
        },

        emitSessionEnded(sessionId: string): void {
            // session_ended is a server→client event; the runner uses
            // session_killed to notify the server that a session has ended.
            socket.emit("session_killed", { sessionId });
        },

        onSkillRequest(handler: (data: unknown) => unknown): void {
            socket.on("list_skills", (data) => {
                const result = handler(data);
                socket.emit("skills_list", {
                    skills: Array.isArray(result) ? result : [],
                    requestId: (data as { requestId?: string }).requestId,
                });
            });
        },

        onFileRequest(handler: (data: unknown) => unknown): void {
            socket.on("list_files", (data) => {
                const result = handler(data);
                socket.emit("file_result", {
                    ...(typeof result === "object" && result !== null ? result : {}),
                    requestId: (data as { requestId?: string }).requestId,
                });
            });
        },

        waitForEvent(eventName: string, timeout = 5_000): Promise<unknown> {
            return new Promise<unknown>((resolve, reject) => {
                // P2: Store the handler reference so we can remove it on timeout
                // (socket.once listeners must be cleaned up to avoid leaks).
                const handler = (data: unknown): void => {
                    clearTimeout(timer);
                    resolve(data);
                };

                const timer = setTimeout(() => {
                    // Remove the once-listener that was never triggered
                    socket.off(eventName, handler);
                    reject(new Error(`Timed out waiting for event "${eventName}" after ${timeout}ms`));
                }, timeout);

                socket.once(eventName, handler);
            });
        },

        async disconnect(): Promise<void> {
            if (!socket.connected) return;
            await new Promise<void>((resolve) => {
                socket.once("disconnect", () => resolve());
                socket.disconnect();
            });
        },
    };

    return runner;
}
