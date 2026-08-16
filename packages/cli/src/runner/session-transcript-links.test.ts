import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTranscriptLink, lookupTranscriptLink } from "./session-transcript-links.js";

describe("relay session → transcript links", () => {
    let dir: string;
    let linksPath: string;
    let transcript: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-links-"));
        linksPath = join(dir, "links.json");
        transcript = join(dir, "2026-08-16T16-13-41-460Z_01a00b59.jsonl");
        writeFileSync(transcript, "{}\n");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("a relay session id resolves to the transcript its worker reported", () => {
        recordTranscriptLink("relay-1", transcript, linksPath);
        expect(lookupTranscriptLink("relay-1", linksPath)).toBe(transcript);
    });

    test("the newest transcript wins (session did /new or resumed another file)", () => {
        const newer = join(dir, "2026-08-16T16-18-02-604Z_01a00b5d.jsonl");
        writeFileSync(newer, "{}\n");
        recordTranscriptLink("relay-1", transcript, linksPath);
        recordTranscriptLink("relay-1", newer, linksPath);
        expect(lookupTranscriptLink("relay-1", linksPath)).toBe(newer);
    });

    test("a deleted transcript resolves to nothing, so the respawn starts fresh instead of failing", () => {
        recordTranscriptLink("relay-1", transcript, linksPath);
        rmSync(transcript);
        expect(lookupTranscriptLink("relay-1", linksPath)).toBeUndefined();
    });

    test("unknown ids and a missing/corrupt store are not fatal", () => {
        expect(lookupTranscriptLink("never-seen", linksPath)).toBeUndefined();
        writeFileSync(linksPath, "{ not json");
        expect(lookupTranscriptLink("relay-1", linksPath)).toBeUndefined();
        recordTranscriptLink("relay-1", transcript, linksPath);
        expect(lookupTranscriptLink("relay-1", linksPath)).toBe(transcript);
    });

    test("prunes oldest entries past the cap so the file cannot grow forever", () => {
        for (let i = 0; i < 520; i++) recordTranscriptLink(`relay-${i}`, transcript, linksPath);
        expect(lookupTranscriptLink("relay-0", linksPath)).toBeUndefined();
        expect(lookupTranscriptLink("relay-519", linksPath)).toBe(transcript);
    });
});
