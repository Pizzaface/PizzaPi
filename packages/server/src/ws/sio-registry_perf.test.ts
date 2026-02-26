import { describe, it, expect, mock } from "bun:test";
import * as sioRegistry from "./sio-registry.js";
import * as sioState from "./sio-state.js";

// Mock the module
mock.module("./sio-state.js", () => {
    const mockGetAllSessions = mock((filterUserId?: string) => {
        const sessions = [
            // User 1 sessions
            { sessionId: "s1", runnerId: "r1", userId: "u1", isActive: true },
            { sessionId: "s2", runnerId: "r1", userId: "u1", isActive: false },
            { sessionId: "s3", runnerId: "r2", userId: "u1", isActive: true },
            // User 2 sessions
            { sessionId: "s4", runnerId: "r3", userId: "u2", isActive: true },
            // Public runner session (owned by u1)
            { sessionId: "s5", runnerId: "r4", userId: "u1", isActive: true },
            // Orphan session (no runner)
            { sessionId: "s6", runnerId: null, userId: "u1", isActive: true },
        ];

        if (filterUserId) {
            return Promise.resolve(sessions.filter(s => s.userId === filterUserId));
        }
        return Promise.resolve(sessions);
    });

    const mockGetAllRunners = mock((filterUserId?: string) => {
        const runners = [
            { runnerId: "r1", userId: "u1", name: "Runner 1", roots: "[]", skills: "[]" },
            { runnerId: "r2", userId: "u1", name: "Runner 2", roots: "[]", skills: "[]" },
            { runnerId: "r3", userId: "u2", name: "Runner 3", roots: "[]", skills: "[]" },
            { runnerId: "r4", userId: null, name: "Public Runner", roots: "[]", skills: "[]" },
        ];
        if (filterUserId) {
            return Promise.resolve(runners.filter(r => r.userId === filterUserId));
        }
        return Promise.resolve(runners);
    });

    return {
        getAllRunners: mockGetAllRunners,
        getAllSessions: mockGetAllSessions,
        // Dummy implementations for other exports
        setSession: () => {},
        getSession: () => {},
        updateSessionFields: () => {},
        deleteSession: () => {},
        refreshSessionTTL: () => {},
        incrementSeq: () => {},
        getSeq: () => {},
        setRunner: () => {},
        getRunner: () => {},
        updateRunnerFields: () => {},
        deleteRunner: () => {},
        refreshRunnerTTL: () => {},
        setTerminal: () => {},
        getTerminal: () => {},
        updateTerminalFields: () => {},
        deleteTerminal: () => {},
        getTerminalsForRunner: () => {},
        setPendingRunnerLink: () => {},
        getPendingRunnerLink: () => {},
        deletePendingRunnerLink: () => {},
        scanExpiredSessions: () => {},
        cleanStaleIndexEntries: () => {},
        initStateRedis: () => {},
        getStateRedis: () => null,
    };
});

describe("getRunners performance", () => {
    it("should correctly count sessions for each runner", async () => {
        const runners = await sioRegistry.getRunners();
        expect(runners).toHaveLength(4);

        const r1 = runners.find(r => r.runnerId === "r1");
        expect(r1?.sessionCount).toBe(2); // s1, s2

        const r2 = runners.find(r => r.runnerId === "r2");
        expect(r2?.sessionCount).toBe(1); // s3

        const r3 = runners.find(r => r.runnerId === "r3");
        expect(r3?.sessionCount).toBe(1); // s4

        const r4 = runners.find(r => r.runnerId === "r4");
        expect(r4?.sessionCount).toBe(1); // s5
    });

    it("should correctly filter by user", async () => {
        const runners = await sioRegistry.getRunners("u1");
        expect(runners).toHaveLength(2); // r1, r2 (u1's runners)

        const r1 = runners.find(r => r.runnerId === "r1");
        expect(r1?.sessionCount).toBe(2); // s1, s2 (owned by u1)
    });
});
