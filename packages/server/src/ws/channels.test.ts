// ============================================================================
// channels.test.ts — Unit tests for ChannelManager
//
// Tests join, leave, broadcast helpers, disconnect cleanup, and edge cases.
// Pure in-memory — no Redis, no network.
// ============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import { ChannelManager } from "./channels.js";

describe("ChannelManager", () => {
    let cm: ChannelManager;

    beforeEach(() => {
        cm = new ChannelManager();
    });

    // ── join ─────────────────────────────────────────────────────────────────

    describe("join", () => {
        it("adds a session to a channel and returns members", () => {
            const members = cm.join("ch1", "session-a");
            expect(members).toEqual(["session-a"]);
        });

        it("adds multiple sessions to the same channel", () => {
            cm.join("ch1", "session-a");
            const members = cm.join("ch1", "session-b");
            expect(members.sort()).toEqual(["session-a", "session-b"]);
        });

        it("is idempotent — joining twice doesn't duplicate", () => {
            cm.join("ch1", "session-a");
            const members = cm.join("ch1", "session-a");
            expect(members).toEqual(["session-a"]);
        });

        it("tracks channels independently", () => {
            cm.join("ch1", "session-a");
            cm.join("ch2", "session-b");
            expect(cm.getMembers("ch1")).toEqual(["session-a"]);
            expect(cm.getMembers("ch2")).toEqual(["session-b"]);
        });

        it("allows a session to join multiple channels", () => {
            cm.join("ch1", "session-a");
            cm.join("ch2", "session-a");
            expect(cm.getChannelsForSession("session-a").sort()).toEqual(["ch1", "ch2"]);
        });
    });

    // ── leave ────────────────────────────────────────────────────────────────

    describe("leave", () => {
        it("removes a session from a channel", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            const remaining = cm.leave("ch1", "session-a");
            expect(remaining).toEqual(["session-b"]);
        });

        it("returns null when channel becomes empty", () => {
            cm.join("ch1", "session-a");
            const remaining = cm.leave("ch1", "session-a");
            expect(remaining).toBeNull();
        });

        it("deletes empty channel from internal map", () => {
            cm.join("ch1", "session-a");
            cm.leave("ch1", "session-a");
            expect(cm.getMembers("ch1")).toEqual([]);
            expect(cm.channelCount).toBe(0);
        });

        it("returns null for non-existent channel", () => {
            expect(cm.leave("nonexistent", "session-a")).toBeNull();
        });

        it("does not throw when removing non-member from channel", () => {
            cm.join("ch1", "session-a");
            const remaining = cm.leave("ch1", "session-b");
            // session-b was never in ch1, so ch1 still has session-a
            expect(remaining).toEqual(["session-a"]);
        });

        it("cleans up session reverse index when session leaves all channels", () => {
            cm.join("ch1", "session-a");
            cm.leave("ch1", "session-a");
            expect(cm.getChannelsForSession("session-a")).toEqual([]);
            expect(cm.sessionCount).toBe(0);
        });
    });

    // ── getMembers ───────────────────────────────────────────────────────────

    describe("getMembers", () => {
        it("returns empty array for non-existent channel", () => {
            expect(cm.getMembers("nonexistent")).toEqual([]);
        });

        it("returns all members of a channel", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            cm.join("ch1", "session-c");
            expect(cm.getMembers("ch1").sort()).toEqual(["session-a", "session-b", "session-c"]);
        });
    });

    // ── isMember ─────────────────────────────────────────────────────────────

    describe("isMember", () => {
        it("returns true for a member", () => {
            cm.join("ch1", "session-a");
            expect(cm.isMember("ch1", "session-a")).toBe(true);
        });

        it("returns false for a non-member", () => {
            cm.join("ch1", "session-a");
            expect(cm.isMember("ch1", "session-b")).toBe(false);
        });

        it("returns false for non-existent channel", () => {
            expect(cm.isMember("nonexistent", "session-a")).toBe(false);
        });
    });

    // ── getOtherMembers ──────────────────────────────────────────────────────

    describe("getOtherMembers", () => {
        it("returns all members except the excluded one", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            cm.join("ch1", "session-c");
            const others = cm.getOtherMembers("ch1", "session-a");
            expect(others.sort()).toEqual(["session-b", "session-c"]);
        });

        it("returns empty array when only member is excluded", () => {
            cm.join("ch1", "session-a");
            expect(cm.getOtherMembers("ch1", "session-a")).toEqual([]);
        });

        it("returns empty array for non-existent channel", () => {
            expect(cm.getOtherMembers("nonexistent", "session-a")).toEqual([]);
        });
    });

    // ── getChannelsForSession ────────────────────────────────────────────────

    describe("getChannelsForSession", () => {
        it("returns empty array for unknown session", () => {
            expect(cm.getChannelsForSession("unknown")).toEqual([]);
        });

        it("returns all channels a session belongs to", () => {
            cm.join("ch1", "session-a");
            cm.join("ch2", "session-a");
            cm.join("ch3", "session-a");
            expect(cm.getChannelsForSession("session-a").sort()).toEqual(["ch1", "ch2", "ch3"]);
        });
    });

    // ── removeFromAll ────────────────────────────────────────────────────────

    describe("removeFromAll", () => {
        it("removes session from all channels", () => {
            cm.join("ch1", "session-a");
            cm.join("ch2", "session-a");
            cm.join("ch1", "session-b");

            cm.removeFromAll("session-a");

            expect(cm.isMember("ch1", "session-a")).toBe(false);
            expect(cm.isMember("ch2", "session-a")).toBe(false);
            expect(cm.getChannelsForSession("session-a")).toEqual([]);
        });

        it("returns affected channels with remaining members", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            cm.join("ch2", "session-a");

            const affected = cm.removeFromAll("session-a");

            // ch1 still has session-b, ch2 is now empty (deleted)
            expect(affected.has("ch1")).toBe(true);
            expect(affected.get("ch1")).toEqual(["session-b"]);
            expect(affected.has("ch2")).toBe(false); // empty channel deleted
        });

        it("does not include empty channels in affected map", () => {
            cm.join("ch1", "session-a");

            const affected = cm.removeFromAll("session-a");
            expect(affected.size).toBe(0);
            expect(cm.channelCount).toBe(0);
        });

        it("is a no-op for unknown session", () => {
            cm.join("ch1", "session-a");

            const affected = cm.removeFromAll("unknown-session");
            expect(affected.size).toBe(0);
            expect(cm.getMembers("ch1")).toEqual(["session-a"]);
        });

        it("does not affect other sessions", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            cm.join("ch2", "session-b");

            cm.removeFromAll("session-a");

            expect(cm.isMember("ch1", "session-b")).toBe(true);
            expect(cm.isMember("ch2", "session-b")).toBe(true);
        });
    });

    // ── channelCount / sessionCount ──────────────────────────────────────────

    describe("counts", () => {
        it("channelCount starts at 0", () => {
            expect(cm.channelCount).toBe(0);
        });

        it("sessionCount starts at 0", () => {
            expect(cm.sessionCount).toBe(0);
        });

        it("tracks channel count correctly", () => {
            cm.join("ch1", "session-a");
            cm.join("ch2", "session-a");
            expect(cm.channelCount).toBe(2);

            cm.leave("ch1", "session-a");
            expect(cm.channelCount).toBe(1);
        });

        it("tracks session count correctly", () => {
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            expect(cm.sessionCount).toBe(2);

            cm.removeFromAll("session-a");
            expect(cm.sessionCount).toBe(1);
        });
    });

    // ── complex scenarios ────────────────────────────────────────────────────

    describe("complex scenarios", () => {
        it("handles 10 members joining a channel", () => {
            const sessions = Array.from({ length: 10 }, (_, i) => `session-${i}`);
            for (const s of sessions) {
                cm.join("broadcast-ch", s);
            }

            expect(cm.getMembers("broadcast-ch")).toHaveLength(10);
            expect(cm.getOtherMembers("broadcast-ch", "session-0")).toHaveLength(9);
        });

        it("handles session disconnect cleanup with multiple channels", () => {
            // session-a joins 3 channels, each with other members
            cm.join("ch1", "session-a");
            cm.join("ch1", "session-b");
            cm.join("ch2", "session-a");
            cm.join("ch2", "session-c");
            cm.join("ch3", "session-a");
            cm.join("ch3", "session-d");
            cm.join("ch3", "session-e");

            // session-a disconnects
            const affected = cm.removeFromAll("session-a");

            expect(affected.size).toBe(3);
            expect(affected.get("ch1")).toEqual(["session-b"]);
            expect(affected.get("ch2")).toEqual(["session-c"]);
            expect(affected.get("ch3")!.sort()).toEqual(["session-d", "session-e"]);

            expect(cm.sessionCount).toBe(4); // b, c, d, e
            expect(cm.channelCount).toBe(3);
        });

        it("full lifecycle: join → message → leave → disconnect", () => {
            // 3 sessions join a channel
            cm.join("project", "coordinator");
            cm.join("project", "worker-1");
            cm.join("project", "worker-2");

            // Check broadcast targets
            const targets = cm.getOtherMembers("project", "coordinator");
            expect(targets.sort()).toEqual(["worker-1", "worker-2"]);

            // worker-1 leaves voluntarily
            const afterLeave = cm.leave("project", "worker-1");
            expect(afterLeave!.sort()).toEqual(["coordinator", "worker-2"]);

            // worker-2 disconnects unexpectedly
            const affected = cm.removeFromAll("worker-2");
            expect(affected.get("project")).toEqual(["coordinator"]);

            // Only coordinator remains
            expect(cm.getMembers("project")).toEqual(["coordinator"]);
        });
    });
});
