// ============================================================================
// sio-state/serialization.ts — Hash serialization helpers
// ============================================================================

import type {
    RedisSessionData,
    RedisSessionSummaryData,
    RedisRunnerData,
    RedisTerminalData,
} from "./types.js";

/** Convert a data object to a flat Record<string, string> for Redis HSET. */
export function toHashFields(data: Record<string, unknown>): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) {
            fields[key] = "";
        } else if (typeof value === "boolean") {
            fields[key] = value ? "1" : "0";
        } else if (typeof value === "number") {
            fields[key] = String(value);
        } else {
            fields[key] = String(value);
        }
    }
    return fields;
}

export const SESSION_SUMMARY_FIELDS = [
    "sessionId",
    "shareUrl",
    "cwd",
    "startedAt",
    "userId",
    "userName",
    "sessionName",
    "isEphemeral",
    "expiresAt",
    "isActive",
    "lastHeartbeatAt",
    "lastHeartbeat",
    "runnerId",
    "runnerName",
    "parentSessionId",
] as const;

export function parseSessionSummaryFromHash(hash: Record<string, string>): RedisSessionSummaryData | null {
    if (!hash.sessionId) return null;
    return {
        sessionId: hash.sessionId,
        shareUrl: hash.shareUrl ?? "",
        cwd: hash.cwd ?? "",
        startedAt: hash.startedAt ?? "",
        userId: hash.userId || null,
        userName: hash.userName || null,
        sessionName: hash.sessionName || null,
        isEphemeral: hash.isEphemeral === "1",
        expiresAt: hash.expiresAt || null,
        isActive: hash.isActive === "1",
        lastHeartbeatAt: hash.lastHeartbeatAt || null,
        lastHeartbeat: hash.lastHeartbeat || null,
        runnerId: hash.runnerId || null,
        runnerName: hash.runnerName || null,
        parentSessionId: hash.parentSessionId || null,
    };
}

export function rowToSummaryHash(row: unknown): Record<string, string> | null {
    // node-redis hmGet returns string[] in field order.
    if (Array.isArray(row)) {
        const hash: Record<string, string> = {};
        for (let i = 0; i < SESSION_SUMMARY_FIELDS.length; i++) {
            const key = SESSION_SUMMARY_FIELDS[i];
            const value = row[i];
            hash[key] = value == null ? "" : String(value);
        }
        return hash;
    }

    // Fallback for test mocks that return an object (same as hGetAll shape).
    if (row && typeof row === "object") {
        return row as Record<string, string>;
    }

    return null;
}

export function parseSessionFromHash(hash: Record<string, string>): RedisSessionData | null {
    if (!hash.sessionId) return null;
    return {
        sessionId: hash.sessionId,
        token: hash.token ?? "",
        collabMode: hash.collabMode === "1",
        shareUrl: hash.shareUrl ?? "",
        cwd: hash.cwd ?? "",
        startedAt: hash.startedAt ?? "",
        userId: hash.userId || null,
        userName: hash.userName || null,
        sessionName: hash.sessionName || null,
        isEphemeral: hash.isEphemeral === "1",
        expiresAt: hash.expiresAt || null,
        isActive: hash.isActive === "1",
        lastHeartbeatAt: hash.lastHeartbeatAt || null,
        lastHeartbeat: hash.lastHeartbeat || null,
        lastState: hash.lastState || null,
        runnerId: hash.runnerId || null,
        runnerName: hash.runnerName || null,
        seq: parseInt(hash.seq ?? "0", 10) || 0,
        parentSessionId: hash.parentSessionId || null,
        linkedParentId: hash.linkedParentId || null,
        metaState: hash.metaState || null,
        workerType: (hash.workerType === "claude-code" ? "claude-code" : hash.workerType === "pi" ? "pi" : null) as "pi" | "claude-code" | null | undefined,
    };
}

export function parseRunnerFromHash(hash: Record<string, string>): RedisRunnerData | null {
    if (!hash.runnerId) return null;
    return {
        runnerId: hash.runnerId,
        userId: hash.userId || null,
        userName: hash.userName || null,
        name: hash.name || null,
        roots: hash.roots || "[]",
        skills: hash.skills || "[]",
        agents: hash.agents || "[]",
        plugins: hash.plugins || "[]",
        hooks: hash.hooks || "[]",
        version: hash.version || null,
        platform: hash.platform || null,
        serviceIds: hash.serviceIds || undefined,
        panels: hash.panels || undefined,
        triggerDefs: hash.triggerDefs || undefined,
    };
}

export function parseTerminalFromHash(hash: Record<string, string>): RedisTerminalData | null {
    if (!hash.terminalId) return null;
    return {
        terminalId: hash.terminalId,
        runnerId: hash.runnerId ?? "",
        userId: hash.userId ?? "",
        spawned: hash.spawned === "1",
        exited: hash.exited === "1",
        spawnOpts: hash.spawnOpts || "{}",
    };
}
