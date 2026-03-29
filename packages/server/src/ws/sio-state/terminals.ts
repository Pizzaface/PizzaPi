// ============================================================================
// sio-state/terminals.ts — Terminal CRUD
// ============================================================================

import { requireRedis } from "./client.js";
import { terminalKey, runnerTerminalsKey } from "./keys.js";
import { TERMINAL_TTL_SECONDS, type RedisTerminalData } from "./types.js";
import { toHashFields, parseTerminalFromHash } from "./serialization.js";

// ── Terminal CRUD ───────────────────────────────────────────────────────────

export async function setTerminal(terminalId: string, data: RedisTerminalData): Promise<void> {
    const r = requireRedis();
    const key = terminalKey(terminalId);
    const fields = toHashFields(data as unknown as Record<string, unknown>);

    const multi = r.multi();
    multi.hSet(key, fields);
    multi.expire(key, TERMINAL_TTL_SECONDS);

    // Add to per-runner index
    multi.sAdd(runnerTerminalsKey(data.runnerId), terminalId);
    multi.expire(runnerTerminalsKey(data.runnerId), TERMINAL_TTL_SECONDS);

    await multi.exec();
}

export async function getTerminal(terminalId: string): Promise<RedisTerminalData | null> {
    const r = requireRedis();
    const hash = await r.hGetAll(terminalKey(terminalId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return parseTerminalFromHash(hash);
}

export async function updateTerminalFields(
    terminalId: string,
    fields: Partial<RedisTerminalData>,
): Promise<void> {
    const r = requireRedis();
    const key = terminalKey(terminalId);
    const exists = await r.exists(key);
    if (!exists) return;

    const hashFields = toHashFields(fields as unknown as Record<string, unknown>);
    const multi = r.multi();
    multi.hSet(key, hashFields);
    multi.expire(key, TERMINAL_TTL_SECONDS);
    await multi.exec();
}

export async function deleteTerminal(terminalId: string): Promise<void> {
    const r = requireRedis();
    const terminal = await getTerminal(terminalId);

    const multi = r.multi();
    multi.del(terminalKey(terminalId));

    if (terminal?.runnerId) {
        multi.sRem(runnerTerminalsKey(terminal.runnerId), terminalId);
    }

    await multi.exec();
}

export async function getTerminalsForRunner(runnerId: string): Promise<RedisTerminalData[]> {
    const r = requireRedis();
    const terminalIds = await r.sMembers(runnerTerminalsKey(runnerId));
    if (terminalIds.length === 0) return [];

    const results: RedisTerminalData[] = [];
    const multi = r.multi();
    for (const id of terminalIds) {
        multi.hGetAll(terminalKey(id));
    }
    const responses = await multi.exec();

    for (const resp of responses) {
        const hash = resp as Record<string, string> | null;
        if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
            const parsed = parseTerminalFromHash(hash);
            if (parsed) results.push(parsed);
        }
    }

    return results;
}
