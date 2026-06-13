import { describe, expect, test } from "bun:test";
import {
    pruneSessionCloseMetadata,
    type RunningSessionLookup,
    type SessionCloseMetadata,
} from "./session-close-metadata.js";

const noneRunning: RunningSessionLookup = { has: () => false };

function entry(updatedAt: number, sessionFile?: string): SessionCloseMetadata {
    return {
        cwd: "/tmp/project",
        updatedAt,
        ...(sessionFile ? { sessionFile } : {}),
    };
}

describe("pruneSessionCloseMetadata", () => {
    test("expires ended sessions without transcript files after the short TTL", () => {
        const metadata = new Map<string, SessionCloseMetadata>([
            ["old", entry(0)],
            ["fresh", entry(9)],
        ]);

        const deleted = pruneSessionCloseMetadata(metadata, noneRunning, 10, {
            ttlMs: 10,
            withFileTtlMs: 100,
            maxEntries: 100,
        });

        expect(deleted).toBe(1);
        expect(metadata.has("old")).toBe(false);
        expect(metadata.has("fresh")).toBe(true);
    });

    test("keeps transcript-file metadata longer but still expires it", () => {
        const metadata = new Map<string, SessionCloseMetadata>([
            ["plain", entry(0)],
            ["with-file", entry(0, "/tmp/session.jsonl")],
        ]);

        pruneSessionCloseMetadata(metadata, noneRunning, 50, {
            ttlMs: 10,
            withFileTtlMs: 100,
            maxEntries: 100,
        });

        expect(metadata.has("plain")).toBe(false);
        expect(metadata.has("with-file")).toBe(true);

        pruneSessionCloseMetadata(metadata, noneRunning, 100, {
            ttlMs: 10,
            withFileTtlMs: 100,
            maxEntries: 100,
        });

        expect(metadata.has("with-file")).toBe(false);
    });

    test("does not prune currently running sessions", () => {
        const metadata = new Map<string, SessionCloseMetadata>([
            ["running", entry(0)],
            ["ended", entry(0)],
        ]);
        const running: RunningSessionLookup = { has: (id) => id === "running" };

        pruneSessionCloseMetadata(metadata, running, 100, {
            ttlMs: 10,
            withFileTtlMs: 10,
            maxEntries: 1,
        });

        expect(metadata.has("running")).toBe(true);
        expect(metadata.has("ended")).toBe(false);
    });

    test("trims oldest ended sessions when the map exceeds the max size", () => {
        const metadata = new Map<string, SessionCloseMetadata>([
            ["oldest", entry(1, "/tmp/oldest.jsonl")],
            ["middle", entry(2, "/tmp/middle.jsonl")],
            ["newest", entry(3, "/tmp/newest.jsonl")],
        ]);

        const deleted = pruneSessionCloseMetadata(metadata, noneRunning, 4, {
            ttlMs: 1_000,
            withFileTtlMs: 1_000,
            maxEntries: 2,
        });

        expect(deleted).toBe(1);
        expect([...metadata.keys()]).toEqual(["middle", "newest"]);
    });
});

