/**
 * TestScenario — BDD-style fluent builder for composing test environments.
 *
 * Provides a declarative API for setting up full multi-component test
 * scenarios with automatic cleanup.
 *
 * # Socket.IO Manager sharing caveat
 *
 * socket.io-client caches Managers by base URL. Hub sockets use
 * `extraHeaders: { cookie }` for HTTP-level auth; relay sockets use
 * `auth: { apiKey }` in the socket.io namespace packet. When hub and relay
 * share the same Manager (same base URL, no forceNew), the relay namespace
 * connect travels over a connection whose HTTP upgrade was performed with
 * the hub's cookies, which can cause the server's relay middleware to
 * behave unexpectedly (silent drop, no connect_error) leading to an
 * indefinite hang.
 *
 * Fix: relay sockets are created with `forceNew: true` so each relay gets
 * its own Manager and its own WebSocket connection, independent of hub.
 *
 * Usage:
 *
 *   const scenario = new TestScenario();
 *   await scenario.setup();                       // creates the test server
 *
 *   const runner = await scenario.addRunner({ name: "r1" });
 *   const sess   = await scenario.addSession({ cwd: "/project" });
 *   const viewer = await scenario.addViewer(sess.sessionId);
 *   const hub    = await scenario.addHub();
 *
 *   await scenario.sendConversation(0, [
 *     { role: "assistant", text: "Hello!" },
 *   ]);
 *
 *   await scenario.teardown();
 */

import { io as connectSocket } from "socket.io-client";
import { createTestServer } from "./server.js";
import { createMockRunner, type MockRunner, type MockRunnerOptions } from "./mock-runner.js";
import { createMockViewer, type MockViewer, type MockViewerOptions } from "./mock-viewer.js";
import { createMockHubClient, type MockHubClient, type MockHubClientOptions } from "./mock-hub.js";
import { buildConversation, type ConversationTurn } from "./builders.js";
import type { TestServer, TestServerOptions, MockRelay, MockRelaySession } from "./types.js";

// ── Stored session record ────────────────────────────────────────────────────

export interface ScenarioSession {
    sessionId: string;
    token: string;
    shareUrl: string;
    relay: MockRelay;
}

// ── Internal relay factory (forceNew: true) ──────────────────────────────────

/**
 * Creates a MockRelay-compatible object whose underlying socket uses
 * `forceNew: true`, preventing Manager sharing with hub/viewer sockets.
 *
 * Functionally equivalent to createMockRelay() from mock-relay.ts but
 * forces an independent Manager so relay and hub auth paths never collide.
 */
async function createIsolatedRelay(server: TestServer): Promise<MockRelay> {
    const socket = connectSocket(`${server.baseUrl}/relay`, {
        auth: { apiKey: server.apiKey },
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        // CRITICAL: prevents Manager sharing with hub/viewer sockets.
        // Hub sockets are authenticated via HTTP cookies (extraHeaders),
        // while relay sockets use socket.io-level auth (apiKey). Sharing
        // the same Manager means relay's namespace connect travels over a
        // WebSocket connection whose HTTP upgrade carried hub's cookies,
        // which causes the relay namespace middleware to silently drop the
        // connection (no connect_error, no connect event) → indefinite hang.
        forceNew: true,
    } as Parameters<typeof connectSocket>[1]);

    // Wait for connection (10 s timeout to avoid infinite hang)
    await new Promise<void>((resolve, reject) => {
        if (socket.connected) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            socket.off("connect", onConnect);
            socket.off("connect_error", onError);
            socket.disconnect();
            reject(new Error("createIsolatedRelay: timed out waiting for /relay to connect after 10 s"));
        }, 10_000);

        const onConnect = () => {
            clearTimeout(timer);
            socket.off("connect_error", onError);
            resolve();
        };
        const onError = (err: Error) => {
            clearTimeout(timer);
            socket.off("connect", onConnect);
            socket.disconnect();
            reject(new Error(`createIsolatedRelay: connect_error: ${err.message}`));
        };

        socket.once("connect", onConnect);
        socket.once("connect_error", onError);
    });

    // Serial register lock (same contract as mock-relay.ts)
    let _registerLock: Promise<unknown> = Promise.resolve();

    function waitForEvent(eventName: string, timeout = 5_000): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const handler = (data: unknown) => {
                clearTimeout(timer);
                resolve(data);
            };
            const timer = setTimeout(() => {
                socket.off(eventName, handler);
                reject(new Error(`createIsolatedRelay.waitForEvent: timed out waiting for "${eventName}"`));
            }, timeout);
            socket.once(eventName, handler);
        });
    }

    async function registerSession(opts?: {
        sessionId?: string;
        cwd?: string;
        ephemeral?: boolean;
        collabMode?: boolean;
        sessionName?: string | null;
        parentSessionId?: string | null;
    }): Promise<MockRelaySession> {
        const doRegister = async (): Promise<MockRelaySession> => {
            const registeredPromise = waitForEvent("registered");
            socket.emit("register", {
                sessionId: opts?.sessionId,
                cwd: opts?.cwd ?? "/tmp/mock-session",
                ephemeral: opts?.ephemeral ?? true,
                collabMode: opts?.collabMode ?? false,
                sessionName: opts?.sessionName ?? null,
                parentSessionId: opts?.parentSessionId ?? null,
            });
            const data = await registeredPromise as { sessionId: string; token: string; shareUrl: string };
            return { sessionId: data.sessionId, token: data.token, shareUrl: data.shareUrl };
        };

        const result = _registerLock.then(doRegister, doRegister);
        _registerLock = result.then(() => {}, () => {});
        return result;
    }

    const relay: MockRelay = {
        socket,

        registerSession,

        emitEvent(sessionId: string, token: string, event: unknown, seq?: number): void {
            socket.emit("event", { sessionId, token, event, ...(seq !== undefined ? { seq } : {}) });
        },

        emitSessionEnd(sessionId: string, token: string): void {
            socket.emit("session_end", { sessionId, token });
        },

        emitTrigger(data): void {
            socket.emit("session_trigger", data);
        },

        emitTriggerResponse(data): void {
            socket.emit("trigger_response", data);
        },

        emitSessionMessage(data): void {
            socket.emit("session_message", data);
        },

        waitForEvent,

        async disconnect(): Promise<void> {
            if (socket.connected) {
                await new Promise<void>((resolve) => {
                    socket.once("disconnect", () => resolve());
                    socket.disconnect();
                });
            } else {
                // Socket might be in "connecting" state — force-disconnect it
                socket.disconnect();
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        },
    };

    return relay;
}

// ── TestScenario ─────────────────────────────────────────────────────────────

export class TestScenario {
    private _server: TestServer | null = null;
    private _ownServer = false;
    private _runners: MockRunner[] = [];
    private _sessions: ScenarioSession[] = [];
    private _viewers: MockViewer[] = [];
    private _hub: MockHubClient | null = null;

    // ── Accessors ────────────────────────────────────────────────────────────

    get server(): TestServer {
        if (!this._server) {
            throw new Error("TestScenario: server not initialized — call setup() or setServer() first");
        }
        return this._server;
    }

    get runners(): MockRunner[] {
        return this._runners;
    }

    get sessions(): ScenarioSession[] {
        return this._sessions;
    }

    get viewers(): MockViewer[] {
        return this._viewers;
    }

    get hub(): MockHubClient | null {
        return this._hub;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Initialize the test server. Must be called before any add* methods
     * when using scenario in standalone mode (creates its own server).
     */
    async setup(opts?: TestServerOptions): Promise<void> {
        this._server = await createTestServer(opts);
        this._ownServer = true;
    }

    /**
     * Inject an existing TestServer instead of creating a new one.
     * When using this, teardown() will NOT call server.cleanup() — the
     * caller is responsible for server lifecycle.
     */
    setServer(server: TestServer): void {
        this._server = server;
        this._ownServer = false;
    }

    /**
     * Reset all tracked components (without touching the server).
     * Useful between tests in a shared-server setup.
     */
    async reset(): Promise<void> {
        await this._disconnectComponents();
    }

    /**
     * Tear down all components in reverse creation order.
     * If this scenario owns its server, also cleans it up.
     */
    async teardown(): Promise<void> {
        const errors: unknown[] = [];

        await this._disconnectComponents().catch((e) => errors.push(e));

        // Only clean up the server if we own it
        if (this._ownServer && this._server) {
            try {
                // Gracefully disconnect all socket.io clients first
                await this._server.io.disconnectSockets(true);
                // Allow async disconnect handlers to flush (Redis writes)
                await new Promise<void>((r) => setTimeout(r, 100));

                const httpServer = (this._server.io as unknown as {
                    httpServer?: {
                        closeAllConnections?(): void;
                        closeIdleConnections?(): void;
                    };
                }).httpServer;

                // closeAllConnections (Node 18.2+) force-closes all HTTP connections
                // including any lingering WebSocket connections from sockets that never
                // completed their namespace handshake.
                if (typeof httpServer?.closeAllConnections === "function") {
                    httpServer.closeAllConnections();
                } else if (typeof httpServer?.closeIdleConnections === "function") {
                    httpServer.closeIdleConnections();
                }

                await this._server.cleanup();
            } catch (err) {
                errors.push(err);
            }
            this._server = null;
            this._ownServer = false;
        }

        if (errors.length > 0) {
            throw errors[0];
        }
    }

    // ── Component builders ───────────────────────────────────────────────────

    /**
     * Add a mock runner to the scenario.
     */
    async addRunner(opts?: MockRunnerOptions): Promise<MockRunner> {
        const runner = await createMockRunner(this.server, opts);
        this._runners.push(runner);
        return runner;
    }

    /**
     * Add a session via an isolated relay connection (forceNew: true).
     * Returns the session record with sessionId, token, and the relay reference.
     */
    async addSession(opts?: {
        sessionId?: string;
        cwd?: string;
        ephemeral?: boolean;
        collabMode?: boolean;
        sessionName?: string | null;
        parentSessionId?: string | null;
    }): Promise<ScenarioSession> {
        // Use the isolated relay factory (forceNew: true) to avoid Manager
        // sharing with hub sockets which can cause an indefinite connection hang.
        const relay = await createIsolatedRelay(this.server);
        try {
            const { sessionId, token, shareUrl } = await relay.registerSession(opts);
            const record: ScenarioSession = { sessionId, token, shareUrl, relay };
            this._sessions.push(record);
            return record;
        } catch (err) {
            // registerSession() failed — disconnect the relay so it doesn't leak.
            // The socket is not in _sessions yet, so reset()/teardown() won't reach it.
            await relay.disconnect();
            throw err;
        }
    }

    /**
     * Add a viewer for the given sessionId.
     */
    async addViewer(sessionId: string, opts?: MockViewerOptions): Promise<MockViewer> {
        const viewer = await createMockViewer(this.server, sessionId, opts);
        this._viewers.push(viewer);
        return viewer;
    }

    /**
     * Add a hub client.
     */
    async addHub(opts?: MockHubClientOptions): Promise<MockHubClient> {
        const hub = await createMockHubClient(this.server, opts);
        this._hub = hub;
        return hub;
    }

    // ── Scenario actions ─────────────────────────────────────────────────────

    /**
     * Send a conversation through the relay for the session at `sessionIndex`.
     * Skips harness:user_turn events (those arrive via the viewer namespace).
     */
    async sendConversation(
        sessionIndex: number,
        turns: ConversationTurn[],
    ): Promise<void> {
        const session = this._sessions[sessionIndex];
        if (!session) {
            throw new Error(
                `TestScenario.sendConversation: no session at index ${sessionIndex} ` +
                `(${this._sessions.length} sessions registered)`,
            );
        }

        const events = buildConversation(turns);
        let seq = 0;

        for (const event of events) {
            if (
                typeof event === "object" &&
                event !== null &&
                (event as Record<string, unknown>)["type"] === "harness:user_turn"
            ) {
                continue;
            }

            session.relay.emitEvent(session.sessionId, session.token, event, seq++);
            await new Promise<void>((r) => setTimeout(r, 10));
        }
    }

    /**
     * Signal session end for the session at `sessionIndex`.
     */
    async endSession(sessionIndex: number): Promise<void> {
        const session = this._sessions[sessionIndex];
        if (!session) {
            throw new Error(`TestScenario.endSession: no session at index ${sessionIndex}`);
        }
        session.relay.emitSessionEnd(session.sessionId, session.token);
        await new Promise<void>((r) => setTimeout(r, 50));
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private async _disconnectComponents(): Promise<void> {
        const errors: unknown[] = [];

        // Disconnect viewers (reverse order)
        for (let i = this._viewers.length - 1; i >= 0; i--) {
            try { await this._viewers[i].disconnect(); } catch (e) { errors.push(e); }
        }
        this._viewers.length = 0;

        // Disconnect hub
        if (this._hub) {
            try { await this._hub.disconnect(); } catch (e) { errors.push(e); }
            this._hub = null;
        }

        // Disconnect relay sockets (reverse order)
        for (let i = this._sessions.length - 1; i >= 0; i--) {
            try { await this._sessions[i].relay.disconnect(); } catch (e) { errors.push(e); }
        }
        this._sessions.length = 0;

        // Disconnect runners (reverse order)
        for (let i = this._runners.length - 1; i >= 0; i--) {
            try { await this._runners[i].disconnect(); } catch (e) { errors.push(e); }
        }
        this._runners.length = 0;

        if (errors.length > 0) throw errors[0];
    }
}
