import type { ServerWebSocket } from "bun";
import { randomBytes, randomUUID } from "crypto";
import {
    getEphemeralTtlMs,
    recordRelaySessionEnd,
    recordRelaySessionStart,
    recordRelaySessionState,
    touchRelaySession,
} from "../sessions/store.js";
import { appendRelayEventToCache } from "../sessions/redis.js";

export type WsRole = "tui" | "viewer" | "runner" | "hub" | "terminal";

export interface WsData {
    role: WsRole;
    /** Set after registration handshake */
    sessionId?: string;
    /** Auth token (TUI-side, to validate incoming events) */
    token?: string;
    /** Highest cumulative event seq acknowledged back to this TUI connection */
    lastAckedSeq?: number;
    /** For runner role: runner ID */
    runnerId?: string;
    /** For terminal role: terminal ID */
    terminalId?: string;
    /** Authenticated user ID (from API key) */
    userId?: string;
    /** Authenticated user name (from API key) */
    userName?: string;
}

interface SharedSession {
    /** The TUI WebSocket that owns this session */
    tuiWs: ServerWebSocket<WsData>;
    token: string;
    viewers: Set<ServerWebSocket<WsData>>;
    /** Whether viewer chat input is forwarded to the owning TUI session */
    collabMode: boolean;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    userId?: string;
    userName?: string;
    sessionName: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
    /** Last session_active state snapshot from the CLI, replayed to new viewers */
    lastState?: unknown;
    /** Monotonic sequence counter — incremented for every event forwarded to viewers */
    seq: number;
    /** Whether the agent is currently running (set from heartbeat events) */
    isActive: boolean;
    /** ISO timestamp of the most recent heartbeat received from the CLI */
    lastHeartbeatAt: string | null;
    /** Most recent heartbeat payload (forwarded to new viewers on connect) */
    lastHeartbeat: unknown | null;
    /** Runner that spawned this session (if any) */
    runnerId: string | null;
    /** Display name of the runner that spawned this session (if any) */
    runnerName: string | null;
}

export interface RunnerSkill {
    name: string;
    description: string;
    filePath: string;
}

interface RunnerEntry {
    ws: ServerWebSocket<WsData>;
    /** Owner user ID (from API key auth) */
    userId: string | null;
    /** Owner display name (from API key auth) */
    userName: string | null;
    /** Optional display name (host label) */
    name: string | null;
    /** Allowed workspace root directories on the runner (used for scheduling + safety) */
    roots: string[];
    /** Session IDs this runner has spawned (best-effort accounting) */
    sessions: Set<string>;
    /** Global skills reported by this runner */
    skills: RunnerSkill[];
}

// ── Hub connections (web UI watching session list) ────────────────────────────
const hubClients = new Set<ServerWebSocket<WsData>>();

export function addHubClient(ws: ServerWebSocket<WsData>) {
    hubClients.add(ws);
}

export function removeHubClient(ws: ServerWebSocket<WsData>) {
    hubClients.delete(ws);
}

function broadcastToHub(msg: unknown, targetUserId?: string) {
    const data = JSON.stringify(msg);
    for (const ws of hubClients) {
        if (targetUserId && ws.data.userId !== targetUserId) continue;
        try {
            ws.send(data);
        } catch {}
    }
}

// ── Shared TUI sessions (live share) ─────────────────────────────────────────
const sharedSessions = new Map<string, SharedSession>();

/**
 * Pending runner links: maps sessionId → runnerId for cases where the runner
 * sends "session_ready" before the TUI worker has connected and called
 * registerTuiSession. When the TUI registers we apply the link immediately.
 */
const pendingRunnerLinks = new Map<string, string>();

function nextEphemeralExpiry(): string {
    return new Date(Date.now() + getEphemeralTtlMs()).toISOString();
}

function refreshEphemeralExpiry(session: SharedSession) {
    if (!session.isEphemeral) return;
    session.expiresAt = nextEphemeralExpiry();
}

function normalizeSessionName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function modelFromHeartbeat(rawHeartbeat: unknown) {
    const rawModel = (rawHeartbeat as any)?.model;
    return rawModel &&
        typeof rawModel === "object" &&
        typeof (rawModel as any).provider === "string" &&
        typeof (rawModel as any).id === "string"
        ? {
              provider: (rawModel as any).provider as string,
              id: (rawModel as any).id as string,
              name: typeof (rawModel as any).name === "string" ? ((rawModel as any).name as string) : undefined,
          }
        : null;
}

export function registerTuiSession(
    ws: ServerWebSocket<WsData>,
    cwd: string = "",
    opts: { sessionId?: string; isEphemeral?: boolean; collabMode?: boolean; sessionName?: string | null } = {},
): {
    sessionId: string;
    token: string;
    shareUrl: string;
} {
    const requestedSessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    const sessionId = requestedSessionId.length > 0 ? requestedSessionId : randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    const startedAt = new Date().toISOString();
    const userId = ws.data.userId;
    const userName = ws.data.userName;
    const isEphemeral = opts.isEphemeral !== false;
    const collabMode = opts.collabMode !== false;
    const sessionName = normalizeSessionName(opts.sessionName);

    if (sharedSessions.has(sessionId)) {
        endSharedSession(sessionId, "Session reconnected");
    }

    sharedSessions.set(sessionId, {
        tuiWs: ws,
        token,
        viewers: new Set(),
        collabMode,
        shareUrl,
        cwd,
        startedAt,
        userId,
        userName,
        sessionName,
        isEphemeral,
        expiresAt: isEphemeral ? nextEphemeralExpiry() : null,
        seq: 0,
        isActive: false,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        runnerId: null,
        runnerName: null,
    });

    // Apply any pending runner link (race: runner sent "session_ready" before
    // the TUI worker connected and called registerTuiSession).
    const pendingRunnerId = pendingRunnerLinks.get(sessionId);
    if (pendingRunnerId) {
        pendingRunnerLinks.delete(sessionId);
        const runner = runners.get(pendingRunnerId);
        if (runner) {
            const session = sharedSessions.get(sessionId)!;
            session.runnerId = pendingRunnerId;
            session.runnerName = runner.name;
        }
    }

    const linkedSession = sharedSessions.get(sessionId)!;

    void recordRelaySessionStart({
        sessionId,
        userId,
        userName,
        cwd,
        shareUrl,
        startedAt,
        isEphemeral,
    }).catch((error) => {
        console.error("Failed to persist relay session start", error);
    });

    broadcastToHub(
        {
            type: "session_added",
            sessionId,
            shareUrl,
            cwd,
            startedAt,
            userId,
            userName,
            sessionName,
            isEphemeral,
            isActive: false,
            lastHeartbeatAt: null,
            model: null,
            runnerId: linkedSession.runnerId,
            runnerName: linkedSession.runnerName,
        },
        userId,
    );
    return { sessionId, token, shareUrl };
}

/** Returns a public summary of active TUI sessions, optionally filtered by owner. */
export function getSessions(filterUserId?: string) {
    return Array.from(sharedSessions.entries())
        .filter(([, s]) => !filterUserId || s.userId === filterUserId)
        .map(([id, s]) => {
            const model = modelFromHeartbeat(s.lastHeartbeat);

            return {
                sessionId: id,
                shareUrl: s.shareUrl,
                cwd: s.cwd,
                startedAt: s.startedAt,
                viewerCount: s.viewers.size,
                userId: s.userId,
                userName: s.userName,
                sessionName: s.sessionName,
                isEphemeral: s.isEphemeral,
                expiresAt: s.expiresAt,
                isActive: s.isActive,
                lastHeartbeatAt: s.lastHeartbeatAt,
                model,
                runnerId: s.runnerId,
                runnerName: s.runnerName,
            };
        });
}

export function getSharedSession(sessionId: string) {
    return sharedSessions.get(sessionId);
}

export function updateSessionState(sessionId: string, state: unknown) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const stateObj = state && typeof state === "object" ? (state as Record<string, unknown>) : null;
    const hasSessionName = !!stateObj && Object.prototype.hasOwnProperty.call(stateObj, "sessionName");
    const nextSessionName = hasSessionName ? normalizeSessionName(stateObj?.sessionName) : session.sessionName;
    const sessionNameChanged = nextSessionName !== session.sessionName;

    session.lastState = state;
    session.sessionName = nextSessionName;
    refreshEphemeralExpiry(session);

    if (sessionNameChanged) {
        broadcastToHub(
            {
                type: "session_status",
                sessionId,
                isActive: session.isActive,
                lastHeartbeatAt: session.lastHeartbeatAt,
                sessionName: session.sessionName,
                model: modelFromHeartbeat(session.lastHeartbeat),
            },
            session.userId,
        );
    }

    void recordRelaySessionState(sessionId, state).catch((error) => {
        console.error("Failed to persist relay session state", error);
    });
}

export function getSessionState(sessionId: string): unknown | undefined {
    return sharedSessions.get(sessionId)?.lastState;
}

export function touchSessionActivity(sessionId: string) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;
    refreshEphemeralExpiry(session);
    void touchRelaySession(sessionId).catch((error) => {
        console.error("Failed to touch relay session", error);
    });
}

export function addViewer(sessionId: string, ws: ServerWebSocket<WsData>): boolean {
    const session = sharedSessions.get(sessionId);
    if (!session) return false;
    session.viewers.add(ws);
    touchSessionActivity(sessionId);
    return true;
}

export function removeViewer(sessionId: string, ws: ServerWebSocket<WsData>) {
    sharedSessions.get(sessionId)?.viewers.delete(ws);
}

export function broadcastToViewers(sessionId: string, data: string) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;
    for (const viewer of session.viewers) {
        try {
            viewer.send(data);
        } catch {}
    }
}

export function publishSessionEvent(sessionId: string, event: unknown) {
    const session = sharedSessions.get(sessionId);
    if (session) {
        refreshEphemeralExpiry(session);
        session.seq += 1;
    }

    const seq = session?.seq;
    void appendRelayEventToCache(sessionId, event, { isEphemeral: session?.isEphemeral });
    broadcastToViewers(sessionId, JSON.stringify({ type: "event", event, seq }));
}

/** Update session liveness state from a heartbeat event. */
export function updateSessionHeartbeat(sessionId: string, heartbeat: Record<string, unknown>) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const prevHeartbeat = session.lastHeartbeat as any;
    const prevModel = prevHeartbeat?.model;
    const prevModelKey =
        prevModel && typeof prevModel === "object" && typeof prevModel.provider === "string" && typeof prevModel.id === "string"
            ? `${prevModel.provider}/${prevModel.id}`
            : null;

    const hasSessionName = Object.prototype.hasOwnProperty.call(heartbeat, "sessionName");
    const prevSessionName = session.sessionName;

    const wasActive = session.isActive;
    session.isActive = heartbeat.active === true;
    session.lastHeartbeatAt = new Date().toISOString();
    session.lastHeartbeat = heartbeat;
    if (hasSessionName) {
        session.sessionName = normalizeSessionName((heartbeat as any).sessionName);
    }
    refreshEphemeralExpiry(session);

    const nextModel = (heartbeat as any)?.model;
    const nextModelKey =
        nextModel && typeof nextModel === "object" && typeof nextModel.provider === "string" && typeof nextModel.id === "string"
            ? `${nextModel.provider}/${nextModel.id}`
            : null;

    const modelChanged = prevModelKey !== nextModelKey;
    const sessionNameChanged = hasSessionName && prevSessionName !== session.sessionName;

    // Notify hub clients when active status, model, or session name changes.
    if (wasActive !== session.isActive || modelChanged || sessionNameChanged) {
        const model = modelFromHeartbeat(heartbeat);

        broadcastToHub(
            {
                type: "session_status",
                sessionId,
                isActive: session.isActive,
                lastHeartbeatAt: session.lastHeartbeatAt,
                sessionName: session.sessionName,
                model,
            },
            session.userId,
        );
    }
}

/** Returns the current seq counter for a session (used in viewer connected message). */
export function getSessionSeq(sessionId: string): number {
    return sharedSessions.get(sessionId)?.seq ?? 0;
}

/** Returns the last heartbeat payload for a session (replayed to newly-connected viewers). */
export function getSessionLastHeartbeat(sessionId: string): unknown | null {
    return sharedSessions.get(sessionId)?.lastHeartbeat ?? null;
}

/** Sends the current snapshot to a viewer WebSocket (used for resync requests). */
export function sendSnapshotToViewer(sessionId: string, ws: ServerWebSocket<WsData>) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const seq = session.seq;
    if (session.lastHeartbeat) {
        try {
            ws.send(JSON.stringify({ type: "event", event: session.lastHeartbeat, seq }));
        } catch {}
    }
    if (session.lastState !== undefined) {
        try {
            ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: session.lastState }, seq }));
        } catch {}
    }
}

export function endSharedSession(sessionId: string, reason: string = "Session ended") {
    pendingRunnerLinks.delete(sessionId);
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const msg = JSON.stringify({ type: "disconnected", reason });
    for (const viewer of session.viewers) {
        try {
            viewer.send(msg);
            viewer.close(1000, reason);
        } catch {}
    }

    sharedSessions.delete(sessionId);

    void recordRelaySessionEnd(sessionId).catch((error) => {
        console.error("Failed to persist relay session end", error);
    });

    broadcastToHub({ type: "session_removed", sessionId }, session.userId);
}

export function sweepExpiredSharedSessions(nowMs: number = Date.now()) {
    for (const [sessionId, session] of sharedSessions.entries()) {
        if (!session.isEphemeral || !session.expiresAt) continue;
        const expiresAtMs = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;

        try {
            session.tuiWs.send(JSON.stringify({ type: "session_expired", sessionId }));
            session.tuiWs.close(1001, "Session expired");
        } catch {}

        endSharedSession(sessionId, "Session expired");
    }
}

// ── Runner registry ──────────────────────────────────────────────────────────
const runners = new Map<string, RunnerEntry>();

/**
 * Credential store for persistent runner identities.
 * Maps runnerId → runnerSecret (provided by the runner on first registration).
 * Survives reconnects within a server lifetime; the runner persists the secret
 * to disk so it can re-authenticate after a server restart too.
 */
const runnerSecrets = new Map<string, string>();

function normalizeRoot(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    // Normalize slashes and remove trailing slash (except for "/").
    const normalized = trimmed.replace(/\\/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/**
 * Register a runner.
 *
 * If the runner supplies a `requestedRunnerId` + `runnerSecret`:
 *   - On first registration for that ID: store the secret and use the requested ID.
 *   - On subsequent registrations (e.g. server restart): validate the secret; if it
 *     matches, reuse the same ID; if it doesn't, reject with an error string.
 *
 * If no ID/secret is supplied (legacy), a fresh UUID is generated as before.
 *
 * Returns the runnerId string on success, or an Error on authentication failure.
 */
export function registerRunner(
    ws: ServerWebSocket<WsData>,
    info?: { name?: string | null; roots?: string[]; requestedRunnerId?: string; runnerSecret?: string; skills?: RunnerSkill[] },
): string | Error {
    const requestedId = info?.requestedRunnerId?.trim();
    const secret = info?.runnerSecret?.trim();

    let runnerId: string;

    if (requestedId && secret) {
        const existingSecret = runnerSecrets.get(requestedId);
        if (existingSecret !== undefined) {
            // Known runner — validate the secret.
            if (existingSecret !== secret) {
                return new Error(`Runner authentication failed: secret mismatch for runner ${requestedId}`);
            }
            // Re-registration: remove any stale WS entry (the runner reconnected).
            runners.delete(requestedId);
        } else {
            // First time we've seen this runner ID — accept and store the secret.
            runnerSecrets.set(requestedId, secret);
        }
        runnerId = requestedId;
    } else {
        // Legacy path: no persistent identity supplied — generate a fresh ID.
        runnerId = randomUUID();
    }

    const roots = (info?.roots ?? [])
        .filter((r) => typeof r === "string")
        .map(normalizeRoot)
        .filter(Boolean);

    const skills = normalizeSkills(info?.skills);

    runners.set(runnerId, {
        ws,
        userId: ws.data.userId ?? null,
        userName: ws.data.userName ?? null,
        name: info?.name && info.name.trim() ? info.name.trim() : null,
        roots,
        sessions: new Set(),
        skills,
    });
    return runnerId;
}

/** Update the skills list for an already-registered runner. */
export function updateRunnerSkills(runnerId: string, skills: RunnerSkill[]): void {
    const runner = runners.get(runnerId);
    if (!runner) return;
    runner.skills = normalizeSkills(skills);
}

function normalizeSkills(raw: unknown): RunnerSkill[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
        .map((s) => ({
            name: typeof s.name === "string" ? s.name : "",
            description: typeof s.description === "string" ? s.description : "",
            filePath: typeof s.filePath === "string" ? s.filePath : "",
        }))
        .filter((s) => s.name.length > 0);
}

export function recordRunnerSession(runnerId: string, sessionId: string) {
    const runner = runners.get(runnerId);
    if (!runner) return;
    runner.sessions.add(sessionId);
}

/** Associate a session with the runner that spawned it, then notify hub clients. */
export function linkSessionToRunner(runnerId: string, sessionId: string) {
    const runner = runners.get(runnerId);
    if (!runner) return;
    const session = sharedSessions.get(sessionId);
    if (!session) {
        // TUI worker hasn't connected yet — store the link and apply it in
        // registerTuiSession when the session is eventually created.
        pendingRunnerLinks.set(sessionId, runnerId);
        return;
    }

    session.runnerId = runnerId;
    session.runnerName = runner.name;

    broadcastToHub(
        {
            type: "session_status",
            sessionId,
            isActive: session.isActive,
            lastHeartbeatAt: session.lastHeartbeatAt,
            sessionName: session.sessionName,
            model: modelFromHeartbeat(session.lastHeartbeat),
            runnerId,
            runnerName: runner.name,
        },
        session.userId,
    );
}

export function removeRunnerSession(runnerId: string, sessionId: string) {
    const runner = runners.get(runnerId);
    if (!runner) return;
    runner.sessions.delete(sessionId);
}

export function getRunners(filterUserId?: string) {
    return Array.from(runners.entries())
        .filter(([, r]) => !filterUserId || r.userId === filterUserId)
        .map(([id, r]) => ({
            runnerId: id,
            name: r.name,
            roots: r.roots,
            sessionCount: r.sessions.size,
            skills: r.skills,
        }));
}

export function getRunner(runnerId: string) {
    return runners.get(runnerId);
}

export function removeRunner(runnerId: string) {
    runners.delete(runnerId);
}

// ── Terminal registry ─────────────────────────────────────────────────────────
// Maps terminalId → { runnerId, viewerWs } so the relay can bridge data between
// the browser viewer WebSocket and the runner that owns the PTY.

export interface TerminalSpawnOpts {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
}

interface TerminalEntry {
    terminalId: string;
    runnerId: string;
    userId: string;
    viewer: ServerWebSocket<WsData> | null;
    /** Messages buffered while no viewer is attached (replayed on viewer connect). */
    buffer: unknown[];
    /** Whether the terminal process has exited. */
    exited: boolean;
    /** Whether the PTY has been spawned on the runner (deferred until viewer connects). */
    spawned: boolean;
    /** Spawn options saved from the API call, used when the viewer triggers the actual spawn. */
    spawnOpts: TerminalSpawnOpts;
    /** Timer to garbage-collect the entry after exit if no viewer ever connects. */
    gcTimer: ReturnType<typeof setTimeout> | null;
}

/** How long to keep a terminal entry after exit waiting for a late viewer (ms). */
const TERMINAL_GC_DELAY_MS = 30_000;

/** How long to wait for a viewer before cleaning up an unspawned terminal (ms). */
const TERMINAL_PENDING_TIMEOUT_MS = 60_000;

const terminals = new Map<string, TerminalEntry>();

export function registerTerminal(terminalId: string, runnerId: string, userId: string, spawnOpts: TerminalSpawnOpts = {}): void {
    const entry: TerminalEntry = {
        terminalId, runnerId, userId, viewer: null,
        buffer: [], exited: false, spawned: false, spawnOpts,
        gcTimer: null,
    };
    // If no viewer connects within the timeout, clean up the pending entry.
    entry.gcTimer = setTimeout(() => {
        if (!entry.spawned) {
            console.log(`[terminal] GC: removing unspawned terminal entry terminalId=${terminalId} (no viewer connected within ${TERMINAL_PENDING_TIMEOUT_MS}ms)`);
            terminals.delete(terminalId);
        }
    }, TERMINAL_PENDING_TIMEOUT_MS);
    terminals.set(terminalId, entry);
}

export function setTerminalViewer(terminalId: string, ws: ServerWebSocket<WsData>): boolean {
    const entry = terminals.get(terminalId);
    if (!entry) return false;
    entry.viewer = ws;

    // Clear the pending-timeout timer (viewer has connected).
    if (entry.gcTimer && !entry.spawned) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = null;
    }

    // Replay any buffered messages to the newly-attached viewer.
    if (entry.buffer.length > 0) {
        console.log(`[terminal] replaying ${entry.buffer.length} buffered messages to viewer for terminalId=${terminalId}`);
        for (const msg of entry.buffer) {
            try {
                ws.send(JSON.stringify(msg));
            } catch (err) {
                console.error(`[terminal] replay send failed for terminalId=${terminalId}:`, err);
                break;
            }
        }
        entry.buffer.length = 0;
    }

    // If the terminal already exited, we can clean up now that the viewer got all messages.
    if (entry.exited) {
        if (entry.gcTimer) {
            clearTimeout(entry.gcTimer);
            entry.gcTimer = null;
        }
        // Don't remove immediately — the viewer just connected. Remove after a short delay
        // to give it time to process the replayed messages.
        entry.gcTimer = setTimeout(() => terminals.delete(terminalId), 2_000);
    }

    return true;
}

/**
 * Mark the terminal as spawned (PTY started on the runner).
 * Called when the relay sends `new_terminal` to the runner.
 */
export function markTerminalSpawned(terminalId: string): void {
    const entry = terminals.get(terminalId);
    if (entry) entry.spawned = true;
}

export function removeTerminalViewer(terminalId: string, ws: ServerWebSocket<WsData>): void {
    const entry = terminals.get(terminalId);
    if (!entry) return;
    if (entry.viewer === ws) entry.viewer = null;

    // If the terminal already exited and the viewer disconnected, clean up.
    if (entry.exited) {
        if (entry.gcTimer) clearTimeout(entry.gcTimer);
        terminals.delete(terminalId);
    }
}

export function getTerminalEntry(terminalId: string) {
    return terminals.get(terminalId) ?? null;
}

export function removeTerminal(terminalId: string): void {
    const entry = terminals.get(terminalId);
    if (!entry) {
        terminals.delete(terminalId);
        return;
    }

    entry.exited = true;

    // If a viewer is attached, it already received the exit message via sendToTerminalViewer.
    // Clean up after a short delay.
    if (entry.viewer) {
        if (entry.gcTimer) clearTimeout(entry.gcTimer);
        entry.gcTimer = setTimeout(() => terminals.delete(terminalId), 2_000);
        return;
    }

    // No viewer attached — keep the entry around (with buffered messages) so a
    // late-connecting viewer can still receive them.
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
    entry.gcTimer = setTimeout(() => {
        console.log(`[terminal] GC: removing terminal entry terminalId=${terminalId} (no viewer connected within ${TERMINAL_GC_DELAY_MS}ms)`);
        terminals.delete(terminalId);
    }, TERMINAL_GC_DELAY_MS);
}

/** Send data from runner → terminal viewer. */
export function sendToTerminalViewer(terminalId: string, msg: unknown): void {
    const entry = terminals.get(terminalId);
    if (!entry) {
        const type = msg && typeof msg === "object" ? (msg as any).type : "?";
        console.warn(`[terminal] sendToTerminalViewer: no entry for terminalId=${terminalId} (msg.type=${type}) — message dropped`);
        return;
    }
    if (!entry.viewer) {
        // Buffer the message for replay when a viewer connects.
        entry.buffer.push(msg);
        const type = msg && typeof msg === "object" ? (msg as any).type : "?";
        console.log(`[terminal] sendToTerminalViewer: buffered for terminalId=${terminalId} (msg.type=${type}, buffered=${entry.buffer.length})`);
        return;
    }
    try {
        entry.viewer.send(JSON.stringify(msg));
    } catch (err) {
        const type = msg && typeof msg === "object" ? (msg as any).type : "?";
        console.error(`[terminal] sendToTerminalViewer: failed to send to viewer for terminalId=${terminalId} (msg.type=${type}):`, err);
    }
}

/** Get all terminal IDs for a given runner. */
export function getTerminalsForRunner(runnerId: string): string[] {
    const ids: string[] = [];
    for (const [id, entry] of terminals) {
        if (entry.runnerId === runnerId) ids.push(id);
    }
    return ids;
}
