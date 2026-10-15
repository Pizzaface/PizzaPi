import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import liveVoice, { VOICE_PROMPT } from "./extension.ts";
import { flagDir, isLive, LIVE_FLAG_TTL_MS, setLive } from "./flags.ts";
import { handleRequest } from "./service/index.ts";
import type { SpeechEngine } from "./service/engine.ts";
import { decodeWav, resample } from "./service/wav.ts";

function pcm16Wav(samples: number[], sampleRate: number, channels = 1): Uint8Array {
    const data = samples.length * 2;
    const b = Buffer.alloc(44 + data);
    b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8);
    b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34);
    b.write("data", 36); b.writeUInt32LE(data, 40);
    samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
    return new Uint8Array(b);
}

describe("wav", () => {
    test("decodes PCM16 mono", () => {
        const w = decodeWav(pcm16Wav([0, 16384, -32768], 16000));
        expect(w.sampleRate).toBe(16000);
        expect([...w.samples]).toEqual([0, 0.5, -1]);
    });
    test("averages stereo to mono", () => {
        expect([...decodeWav(pcm16Wav([16384, 0, -16384, -16384], 8000, 2)).samples]).toEqual([0.25, -0.5]);
    });
    test("rejects non-wav", () => {
        expect(() => decodeWav(new Uint8Array(20))).toThrow("not a WAV");
    });
    test("resamples 48k -> 16k", () => {
        const out = resample(new Float32Array(48000).fill(0.5), 48000, 16000);
        expect(out.length).toBe(16000);
        expect(out[100]).toBeCloseTo(0.5);
    });
});

describe("live flag", () => {
    const home = mkdtempSync(join(tmpdir(), "live-flag-"));
    test("on/off and expiry", () => {
        expect(isLive("s1", home)).toBe(false);
        expect(setLive("s1", true, home)).toBe(true);
        expect(isLive("s1", home)).toBe(true);
        const old = new Date(Date.now() - LIVE_FLAG_TTL_MS - 1000);
        utimesSync(join(flagDir(home), "s1"), old, old);
        expect(isLive("s1", home)).toBe(false);
        setLive("s1", true, home); // heartbeat refreshes
        expect(isLive("s1", home)).toBe(true);
        setLive("s1", false, home);
        expect(isLive("s1", home)).toBe(false);
    });
    test("extension adds the voice prompt only while the session is live", () => {
        let handler: ((e: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
        liveVoice({ on: (_: string, h: typeof handler) => (handler = h) }, home);
        process.env.PIZZAPI_SESSION_ID = "s2";
        expect(handler!({ systemPrompt: "base" })).toBeUndefined();
        setLive("s2", true, home);
        expect(handler!({ systemPrompt: "base" })?.systemPrompt).toBe(`base${VOICE_PROMPT}`);
        expect(VOICE_PROMPT).toContain("short spoken progress updates at meaningful milestones");
        setLive("s2", false, home);
    });
    test("rejects path traversal ids", () => {
        expect(setLive("../../etc/x", true, home)).toBe(false);
        expect(isLive("../x", home)).toBe(false);
    });
});

describe("http routes", () => {
    const engine = {
        status: () => ({ stt: "ready", tts: "ready", progress: {} }),
        warm: () => {},
        transcribe: async (s: Float32Array) => `got ${s.length}`,
        synthesize: async (t: string, v: string) => new TextEncoder().encode(`${v}:${t}`).buffer,
        voices: async () => ["af_heart"],
    } as unknown as SpeechEngine;
    const call = (path: string, init?: RequestInit) => handleRequest(new Request(`http://x/api/tunnel/auth/tok${path}`, init), engine, "<html>");

    test("stt resamples to 16k under a tunnel prefix", async () => {
        const r = await call("/api/stt", { method: "POST", body: pcm16Wav(new Array(800).fill(0), 8000) });
        expect(await r.json()).toEqual({ text: "got 1600" });
        expect(r.headers.get("access-control-allow-origin")).toBe("*");
    });
    test("tts validates voice and returns wav", async () => {
        const r = await call("/api/tts", { method: "POST", body: JSON.stringify({ text: " hi ", voice: "../bad" }) });
        expect(r.headers.get("content-type")).toBe("audio/wav");
        expect(await r.text()).toBe("af_heart:hi");
        expect((await call("/api/tts", { method: "POST", body: "{}" })).status).toBe(400);
    });
    test("bad wav is a 500 with a message, not a crash", async () => {
        const r = await call("/api/stt", { method: "POST", body: "nope" });
        expect(r.status).toBe(500);
    });
    test("serves panel html", async () => {
        expect(await (await call("/")).text()).toBe("<html>");
    });
});
