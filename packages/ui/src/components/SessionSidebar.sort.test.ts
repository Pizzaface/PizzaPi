/**
 * Unit tests for the session/project sort comparators used in SessionSidebar's
 * liveGroups useMemo. The comparators are pure functions so we can exercise
 * them directly without mounting the component.
 */

import { describe, it, expect } from "bun:test";
import { filterSessionsByMode } from "./SessionSidebar";
import type { ServiceModeDef } from "@pizzapi/protocol";

// ── Minimal type stubs ────────────────────────────────────────────────────────

interface StubSession {
    sessionId: string;
    lastHeartbeatAt?: string;
    startedAt: string;
}

interface StubProject {
    sessions: StubSession[];
}

// ── Comparators (mirrors SessionSidebar liveGroups useMemo) ───────────────────

function makeSessionComparator(pinnedSessionIds: Set<string>) {
    return (a: StubSession, b: StubSession) => {
        const aPinned = pinnedSessionIds.has(a.sessionId) ? 1 : 0;
        const bPinned = pinnedSessionIds.has(b.sessionId) ? 1 : 0;
        if (bPinned !== aPinned) return bPinned - aPinned;
        const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
        const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
        return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
    };
}

function makeProjectComparator(pinnedSessionIds: Set<string>) {
    return (a: StubProject, b: StubProject) => {
        const hasPinned = (grp: StubProject) =>
            grp.sessions.some((s) => pinnedSessionIds.has(s.sessionId)) ? 1 : 0;
        const pinDiff = hasPinned(b) - hasPinned(a);
        if (pinDiff !== 0) return pinDiff;
        const latestTs = (grp: StubProject) =>
            Math.max(
                0,
                ...grp.sessions
                    .map((s) => Date.parse(s.lastHeartbeatAt ?? s.startedAt))
                    .filter(Number.isFinite),
            );
        return latestTs(b) - latestTs(a);
    };
}

describe("session mode filtering", () => {
    const modes: ServiceModeDef[] = [{ id: "work", label: "Work", workspace: "/work" }];
    const sessions = [
        { sessionId: "code", cwd: "/code", runnerId: "runner-a" },
        { sessionId: "work", cwd: "/work", runnerId: "runner-a" },
        { sessionId: "work-child", cwd: "/work-other", runnerId: "runner-a" },
    ];

    it("fails closed when the mode runner is unknown", () => {
        expect(filterSessionsByMode(sessions, "work", modes).map((s) => s.sessionId)).toEqual([]);
    });

    it("keeps all unclaimed sessions in Code mode", () => {
        expect(filterSessionsByMode(sessions, null, modes, "runner-a").map((s) => s.sessionId)).toEqual(["code", "work-child"]);
    });

    it("claims sessions working inside the mode workspace", () => {
        const nested = [
            { sessionId: "root", cwd: "/work", runnerId: "runner-a" },
            { sessionId: "nested", cwd: "/work/clients/acme", runnerId: "runner-a" },
            { sessionId: "sibling", cwd: "/work-other", runnerId: "runner-a" },
        ];
        expect(filterSessionsByMode(nested, "work", modes, "runner-a").map((s) => s.sessionId)).toEqual(["root", "nested"]);
        // ...and the same sessions must not also show up unfiltered.
        expect(filterSessionsByMode(nested, null, modes, "runner-a").map((s) => s.sessionId)).toEqual(["sibling"]);
    });

    it("matches a selected mode by exact cwd on its runner", () => {
        const scopedSessions = [
            { sessionId: "runner-a", cwd: "/work", runnerId: "runner-a" },
            { sessionId: "runner-b", cwd: "/work", runnerId: "runner-b" },
        ];
        expect(filterSessionsByMode(scopedSessions, "work", modes, "runner-a").map((s) => s.sessionId)).toEqual(["runner-a"]);
    });

    it("only claims sessions from the mode's runner", () => {
        const scopedSessions = [
            { sessionId: "runner-a", cwd: "/work", runnerId: "runner-a" },
            { sessionId: "runner-b", cwd: "/work", runnerId: "runner-b" },
        ];
        expect(filterSessionsByMode(scopedSessions, "work", modes, "runner-a").map((s) => s.sessionId)).toEqual(["runner-a"]);
        expect(filterSessionsByMode(scopedSessions, null, modes, "runner-a").map((s) => s.sessionId)).toEqual(["runner-b"]);
    });
});

// ── Session sort tests ────────────────────────────────────────────────────────

describe("session sort (pinned first, then recency)", () => {
    it("places a pinned session before an older unpinned session", () => {
        const pinned = new Set(["s-pinned"]);
        const sessions: StubSession[] = [
            { sessionId: "s-unpinned", startedAt: "2025-01-02T10:00:00Z" }, // more recent
            { sessionId: "s-pinned",   startedAt: "2025-01-01T10:00:00Z" }, // older but pinned
        ];
        sessions.sort(makeSessionComparator(pinned));
        expect(sessions[0].sessionId).toBe("s-pinned");
        expect(sessions[1].sessionId).toBe("s-unpinned");
    });

    it("places a pinned session before a newer unpinned session", () => {
        const pinned = new Set(["s-pinned"]);
        const sessions: StubSession[] = [
            { sessionId: "s-unpinned", startedAt: "2025-03-01T10:00:00Z" }, // newest
            { sessionId: "s-pinned",   startedAt: "2025-01-01T10:00:00Z" }, // older but pinned
        ];
        sessions.sort(makeSessionComparator(pinned));
        expect(sessions[0].sessionId).toBe("s-pinned");
    });

    it("sorts multiple pinned sessions by recency among themselves", () => {
        const pinned = new Set(["s-pin-old", "s-pin-new"]);
        const sessions: StubSession[] = [
            { sessionId: "s-pin-old", startedAt: "2025-01-01T00:00:00Z" },
            { sessionId: "s-pin-new", startedAt: "2025-06-01T00:00:00Z" },
        ];
        sessions.sort(makeSessionComparator(pinned));
        expect(sessions[0].sessionId).toBe("s-pin-new");
        expect(sessions[1].sessionId).toBe("s-pin-old");
    });

    it("sorts unpinned sessions by recency when none are pinned", () => {
        const pinned = new Set<string>();
        const sessions: StubSession[] = [
            { sessionId: "s-old",    startedAt: "2025-01-01T00:00:00Z" },
            { sessionId: "s-recent", startedAt: "2025-06-01T00:00:00Z" },
        ];
        sessions.sort(makeSessionComparator(pinned));
        expect(sessions[0].sessionId).toBe("s-recent");
    });

    it("prefers lastHeartbeatAt over startedAt for recency", () => {
        const pinned = new Set<string>();
        // s-heartbeat started early but has a very recent heartbeat
        const sessions: StubSession[] = [
            { sessionId: "s-heartbeat", startedAt: "2025-01-01T00:00:00Z", lastHeartbeatAt: "2025-12-01T00:00:00Z" },
            { sessionId: "s-newer-start", startedAt: "2025-06-01T00:00:00Z" },
        ];
        sessions.sort(makeSessionComparator(pinned));
        expect(sessions[0].sessionId).toBe("s-heartbeat");
    });
});

// ── Project group sort tests ──────────────────────────────────────────────────

describe("project group sort (groups with pinned sessions first, then recency)", () => {
    it("places a project containing a pinned session before one without", () => {
        const pinned = new Set(["s-pinned"]);
        const projects: StubProject[] = [
            { sessions: [{ sessionId: "s-unpinned", startedAt: "2025-06-01T00:00:00Z" }] },
            { sessions: [{ sessionId: "s-pinned",   startedAt: "2025-01-01T00:00:00Z" }] },
        ];
        projects.sort(makeProjectComparator(pinned));
        expect(projects[0].sessions[0].sessionId).toBe("s-pinned");
    });

    it("sorts two projects without pinned sessions by their most recent session", () => {
        const pinned = new Set<string>();
        const projects: StubProject[] = [
            { sessions: [{ sessionId: "s-old",    startedAt: "2025-01-01T00:00:00Z" }] },
            { sessions: [{ sessionId: "s-recent", startedAt: "2025-06-01T00:00:00Z" }] },
        ];
        projects.sort(makeProjectComparator(pinned));
        expect(projects[0].sessions[0].sessionId).toBe("s-recent");
    });

    it("sorts two projects both containing pinned sessions by recency", () => {
        const pinned = new Set(["s-pin-a", "s-pin-b"]);
        const projects: StubProject[] = [
            { sessions: [{ sessionId: "s-pin-a", startedAt: "2025-01-01T00:00:00Z" }] },
            { sessions: [{ sessionId: "s-pin-b", startedAt: "2025-06-01T00:00:00Z" }] },
        ];
        projects.sort(makeProjectComparator(pinned));
        expect(projects[0].sessions[0].sessionId).toBe("s-pin-b");
    });

    it("a project is considered pinned when any of its sessions is pinned", () => {
        const pinned = new Set(["s-one-pinned"]);
        const projects: StubProject[] = [
            {
                sessions: [
                    { sessionId: "s-unpinned", startedAt: "2025-06-01T00:00:00Z" }, // most recent
                ],
            },
            {
                sessions: [
                    { sessionId: "s-no-pin",    startedAt: "2025-01-01T00:00:00Z" },
                    { sessionId: "s-one-pinned", startedAt: "2025-02-01T00:00:00Z" },
                ],
            },
        ];
        projects.sort(makeProjectComparator(pinned));
        // Project with the pinned session should be first even though the other
        // project has a more recently-active session.
        expect(projects[0].sessions.some((s) => s.sessionId === "s-one-pinned")).toBe(true);
    });
});
