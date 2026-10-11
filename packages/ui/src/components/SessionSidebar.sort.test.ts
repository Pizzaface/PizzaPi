/**
 * Unit tests for SessionSidebar's pure session filtering/selection helpers.
 */

import { describe, it, expect } from "bun:test";
import { filterSessionsByMode, getSelectableSessionIds } from "./SessionSidebar";
import type { ServiceModeDef } from "@pizzapi/protocol";

describe("sidebar bulk selection", () => {
    it("selects only sessions visible after mode filtering and tree collapse", () => {
        const sessions = [
            { sessionId: "visible-root", cwd: "/work", runnerId: "runner-a", shareUrl: "", startedAt: "2025-01-03T00:00:00Z" },
            { sessionId: "hidden-child", cwd: "/work", runnerId: "runner-a", parentSessionId: "visible-root", shareUrl: "", startedAt: "2025-01-04T00:00:00Z" },
        ];
        const groups = [{ projects: [{ sessions }] }];

        expect(getSelectableSessionIds(groups, new Set())).toEqual(["visible-root"]);
        expect(getSelectableSessionIds(groups, new Set(["visible-root"]))).toEqual(["visible-root", "hidden-child"]);
    });
});

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
