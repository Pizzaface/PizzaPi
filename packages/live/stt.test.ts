import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32c, crc32cBase64, ensureModelFiles, groupDir, sweepPartials, type Manifest } from "./service/moonshine-models.ts";
import { MAX_BACKLOG_SAMPLES, MAX_STREAMS, StreamingStt, type HostToWorker, type WorkerToHost } from "./service/stt.ts";
import { sttSocket, type SocketState } from "./service/index.ts";
import { SpeechEngine } from "./service/engine.ts";

describe("model files", () => {
    const body = new TextEncoder().encode("moonshine model bytes");
    const manifest = (over: Partial<{ size: number; checksum: string }> = {}): Manifest => ({
        groups: [{
            base_url: "https://download.moonshine.ai/model/small-streaming-en/quantized_26_07_30",
            files: [{ name: "tokenizer.bin", size: body.length, checksum: crc32cBase64(crc32c(body)), checksum_type: "crc32c", ...over }],
        }],
    });
    const fetcher = (bytes: Uint8Array, calls: string[] = []) => (async (url: string) => {
        calls.push(String(url));
        return new Response(bytes as Uint8Array<ArrayBuffer>);
    }) as unknown as typeof fetch;

    test("crc32c matches the published check value and the CDN's base64 encoding", () => {
        expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
        // Incremental == one-shot.
        expect(crc32c(body.subarray(5), crc32c(body.subarray(0, 5)))).toBe(crc32c(body));
        expect(crc32cBase64(0xe3069283)).toBe("4waSgw==");
    });

    test("downloads, verifies, and reuses a verified cache without refetching", async () => {
        const root = mkdtempSync(join(tmpdir(), "moonshine-"));
        const calls: string[] = [];
        const paths = await ensureModelFiles(manifest(), root, () => {}, fetcher(body, calls));
        expect(readFileSync(paths.get("tokenizer.bin")!)).toEqual(Buffer.from(body));
        await ensureModelFiles(manifest(), root, () => {}, fetcher(body, calls));
        expect(calls).toEqual(["https://download.moonshine.ai/model/small-streaming-en/quantized_26_07_30/tokenizer.bin"]);
        expect(readdirSync(groupDir(root, manifest().groups[0]!.base_url))).toEqual(["tokenizer.bin"]);
    });

    test("an incomplete or corrupt cached file is replaced", async () => {
        const root = mkdtempSync(join(tmpdir(), "moonshine-"));
        const dir = groupDir(root, manifest().groups[0]!.base_url);
        await ensureModelFiles(manifest(), root, () => {}, fetcher(body));
        writeFileSync(join(dir, "tokenizer.bin"), body.subarray(0, 4)); // truncated
        const calls: string[] = [];
        await ensureModelFiles(manifest(), root, () => {}, fetcher(body, calls));
        expect(calls).toHaveLength(1);
        const flipped = Uint8Array.from(body);
        flipped[0]! ^= 1;
        writeFileSync(join(dir, "tokenizer.bin"), flipped); // right size, wrong bytes
        await ensureModelFiles(manifest(), root, () => {}, fetcher(body, calls));
        expect(calls).toHaveLength(2);
        expect(readFileSync(join(dir, "tokenizer.bin"))).toEqual(Buffer.from(body));
    });

    test("a bad download never lands at the final path and leaves no temp file", async () => {
        const root = mkdtempSync(join(tmpdir(), "moonshine-"));
        const dir = groupDir(root, manifest().groups[0]!.base_url);
        const bad = Uint8Array.from(body);
        bad[3]! ^= 1;
        await expect(ensureModelFiles(manifest(), root, () => {}, fetcher(bad))).rejects.toThrow("checksum mismatch");
        await expect(ensureModelFiles(manifest(), root, () => {}, fetcher(body.subarray(0, 3)))).rejects.toThrow("got 3");
        expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    });

    test("a disk write failure during download rejects instead of hanging", async () => {
        const root = mkdtempSync(join(tmpdir(), "moonshine-"));
        const dir = groupDir(root, manifest().groups[0]!.base_url);
        mkdirSync(join(dir, "tokenizer.bin.part-blocker"), { recursive: true });
        // Make the destination directory unwritable so createWriteStream fails.
        chmodSync(dir, 0o500);
        try {
            const big = new Uint8Array(4 << 20);
            const m: Manifest = { groups: [{ base_url: manifest().groups[0]!.base_url, files: [{ name: "tokenizer.bin", size: big.length }] }] };
            await expect(Promise.race([
                ensureModelFiles(m, root, () => {}, fetcher(big)),
                Bun.sleep(5000).then(() => { throw new Error("hung"); }),
            ])).rejects.toThrow(/EACCES|permission/i);
        } finally {
            chmodSync(dir, 0o700);
        }
    });

    test("sweeps temp files from dead downloaders only", () => {
        const dir = mkdtempSync(join(tmpdir(), "moonshine-"));
        for (const n of ["encoder.ort.part-111-abc", "encoder.ort.part-222-def", `x.part-${process.pid}-zz`, "encoder.ort"]) writeFileSync(join(dir, n), "");
        sweepPartials(dir, (pid) => pid === 222);
        expect(readdirSync(dir).sort()).toEqual(["encoder.ort", "encoder.ort.part-222-def", `x.part-${process.pid}-zz`].sort());
    });

    test("rejects path traversal and non-https sources from a manifest", async () => {
        const root = mkdtempSync(join(tmpdir(), "moonshine-"));
        expect(() => groupDir(root, "https://x/a/..")).toThrow();
        expect(() => groupDir(root, "http://download.moonshine.ai/model/a/b")).toThrow("non-https");
        const evil: Manifest = { groups: [{ base_url: "https://download.moonshine.ai/model/a/b", files: [{ name: "../x" }] }] };
        await expect(ensureModelFiles(evil, root, () => {}, fetcher(body))).rejects.toThrow("unexpected model file name");
    });
});

class FakeWorker {
    posted: HostToWorker[] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<WorkerToHost>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(m: HostToWorker) { this.posted.push(m); }
    terminate() { this.terminated = true; }
    emit(m: WorkerToHost) { this.onmessage?.(new MessageEvent("message", { data: m })); }
}

describe("streaming STT host", () => {
    const disposers: Array<() => void> = [];
    afterEach(() => { for (const d of disposers.splice(0)) d(); });
    async function readyStt(idleMs = 60_000) {
        const workers: FakeWorker[] = [];
        const stt = new StreamingStt("/models", () => { const w = new FakeWorker(); workers.push(w); return w as never; }, idleMs);
        disposers.push(() => stt.dispose());
        const ready = stt.warm();
        workers[0]!.emit({ type: "ready" });
        await ready;
        return { stt, worker: workers[0]!, workers };
    }
    const handlers = () => {
        const log: string[] = [];
        return { log, h: { partial: (t: string) => log.push(`partial:${t}`), final: (t: string) => log.push(`final:${t}`), error: (m: string) => log.push(`error:${m}`) } };
    };

    test("routes partials and a single final by stream id; late events after it are dropped", async () => {
        const { stt, worker } = await readyStt();
        const { log, h } = handlers();
        const s = stt.open(h);
        s.audio(new Float32Array(1600));
        worker.emit({ type: "partial", id: 1, text: "Run" });
        s.end();
        s.audio(new Float32Array(1600)); // after end: ignored, never posted
        worker.emit({ type: "final", id: 1, text: "Run it." });
        worker.emit({ type: "final", id: 1, text: "again" });
        worker.emit({ type: "partial", id: 1, text: "late" });
        expect(log).toEqual(["partial:Run", "final:Run it."]);
        expect(worker.posted.map((m) => m.type)).toEqual(["load", "start", "audio", "end"]);
    });

    test("end is posted after every queued audio frame for that stream", async () => {
        const { stt, worker } = await readyStt();
        const s = stt.open(handlers().h);
        for (let i = 0; i < 3; i++) s.audio(new Float32Array(160));
        s.end();
        expect(worker.posted.slice(1).map((m) => m.type)).toEqual(["start", "audio", "audio", "audio", "end"]);
    });

    test("cancel stops delivery for that stream only", async () => {
        const { stt, worker } = await readyStt();
        const a = handlers();
        const b = handlers();
        const sa = stt.open(a.h);
        stt.open(b.h);
        sa.cancel();
        worker.emit({ type: "final", id: 1, text: "cancelled" });
        worker.emit({ type: "final", id: 2, text: "kept" });
        expect(a.log).toEqual([]);
        expect(b.log).toEqual(["final:kept"]);
        expect(worker.posted.at(-1)).toEqual({ type: "cancel", id: 1 });
    });

    test("a worker that falls behind fails the stream instead of buffering more audio", async () => {
        const { stt, worker } = await readyStt();
        const { log, h } = handlers();
        const s = stt.open(h);
        const chunk = 16000;
        for (let sent = 0; sent <= MAX_BACKLOG_SAMPLES; sent += chunk) s.audio(new Float32Array(chunk));
        expect(log).toEqual(["error:speech recognition is falling behind"]);
        expect(worker.posted.at(-1)).toEqual({ type: "cancel", id: 1 });
        const audioPosts = worker.posted.filter((m) => m.type === "audio").length;
        s.audio(new Float32Array(chunk));
        expect(worker.posted.filter((m) => m.type === "audio").length).toBe(audioPosts);
    });

    test("acks release backlog so steady real-time audio is never refused", async () => {
        const { stt, worker } = await readyStt();
        const { log, h } = handlers();
        const s = stt.open(h);
        for (let i = 0; i < 40; i++) {
            s.audio(new Float32Array(16000));
            worker.emit({ type: "ack", id: 1, samples: 16000 });
        }
        expect(log).toEqual([]);
    });

    test("stream count is bounded and streams before ready fail with an error", async () => {
        const workers: FakeWorker[] = [];
        const cold = new StreamingStt("/m", () => { const w = new FakeWorker(); workers.push(w); return w as never; });
        disposers.push(() => cold.dispose());
        // A stream opened before the model is loaded starts the load and queues behind it.
        const early = handlers();
        const s = cold.open(early.h);
        s.audio(new Float32Array(160));
        s.end();
        // Held on the host until ready, so a cancel can free it.
        expect(workers[0]!.posted.map((m) => m.type)).toEqual(["load"]);
        const dropped = cold.open(handlers().h);
        dropped.audio(new Float32Array(160));
        dropped.cancel();
        workers[0]!.emit({ type: "ready" });
        expect(workers[0]!.posted.map((m) => m.type)).toEqual(["load", "start", "audio", "end"]);
        workers[0]!.emit({ type: "final", id: 1, text: "after load" });
        expect(early.log).toEqual(["final:after load"]);
        // A stream that overflows while loading is failed, and its audio is never sent.
        const cold2Workers: FakeWorker[] = [];
        const cold2 = new StreamingStt("/m", () => { const w = new FakeWorker(); cold2Workers.push(w); return w as never; });
        disposers.push(() => cold2.dispose());
        const big = handlers();
        const sb = cold2.open(big.h);
        for (let i = 0; i <= MAX_BACKLOG_SAMPLES / 16000; i++) sb.audio(new Float32Array(16000));
        expect(big.log).toEqual(["error:speech recognition is falling behind"]);
        cold2Workers[0]!.emit({ type: "ready" });
        expect(cold2Workers[0]!.posted.map((m) => m.type)).toEqual(["load"]);
        const { stt } = await readyStt();
        for (let i = 0; i < MAX_STREAMS; i++) stt.open(handlers().h);
        const extra = handlers();
        stt.open(extra.h);
        await Promise.resolve();
        expect(extra.log).toEqual(["error:too many simultaneous speech streams"]);
    });

    test("batch transcriptions share the stream admission limit", async () => {
        const { stt } = await readyStt();
        for (let i = 0; i < MAX_STREAMS; i++) stt.transcribe(new Float32Array(16000)).catch(() => {});
        await expect(stt.transcribe(new Float32Array(16000))).rejects.toThrow("too many simultaneous speech streams");
    });

    test("dispose settles a pending transcription and a pending load", async () => {
        const { stt } = await readyStt();
        const pending = stt.transcribe(new Float32Array(16000));
        const { log, h } = handlers();
        stt.open(h);
        stt.dispose();
        await expect(pending).rejects.toThrow("speech service stopped");
        expect(log).toEqual(["error:speech service stopped"]);
        const workers: FakeWorker[] = [];
        const cold = new StreamingStt("/m", () => { const w = new FakeWorker(); workers.push(w); return w as never; }, 5);
        const loading = cold.warm();
        await Bun.sleep(20); // longer than idleMs: a slow download must not be unloaded
        expect(workers[0]!.terminated).toBe(false);
        cold.dispose();
        await expect(loading).rejects.toThrow("speech service stopped");
        workers[0]!.emit({ type: "ready" }); // late callback from the killed worker
        expect(cold.status().state).toBe("idle");
    });

    test("model load errors surface in status and allow a retry", async () => {
        const workers: FakeWorker[] = [];
        const stt = new StreamingStt("/m", () => { const w = new FakeWorker(); workers.push(w); return w as never; });
        disposers.push(() => stt.dispose());
        const p = stt.warm();
        workers[0]!.emit({ type: "progress", file: "encoder.ort", pct: 42.4 });
        expect(stt.status()).toEqual({ state: "loading", progress: { "encoder.ort": 42 } });
        workers[0]!.emit({ type: "error", message: "download encoder.ort: checksum mismatch" });
        await expect(p).rejects.toThrow("checksum mismatch");
        expect(stt.status()).toEqual({ state: "error", progress: {}, error: "download encoder.ort: checksum mismatch" });
        expect(workers[0]!.terminated).toBe(true);
        void stt.warm().catch(() => {});
        expect(workers).toHaveLength(2);
    });

    test("after a worker crash the next utterance reloads the model and works", async () => {
        const { stt, workers } = await readyStt();
        const first = handlers();
        stt.open(first.h);
        workers[0]!.onerror?.(new ErrorEvent("error", { message: "speech worker exited (SIGKILL)" }));
        expect(first.log).toEqual(["error:speech worker exited (SIGKILL)"]);
        const next = handlers();
        stt.open(next.h);
        expect(workers).toHaveLength(2);
        expect(workers[1]!.posted.map((m) => m.type)).toEqual(["load"]);
        workers[1]!.emit({ type: "ready" });
        expect(workers[1]!.posted.map((m) => m.type)).toEqual(["load", "start"]);
        workers[1]!.emit({ type: "final", id: 2, text: "recovered" });
        expect(next.log).toEqual(["final:recovered"]);
    });

    test("a worker crash fails open streams once and unloads", async () => {
        const { stt, worker } = await readyStt();
        const { log, h } = handlers();
        stt.open(h).end();
        worker.onerror?.(new ErrorEvent("error", { message: "boom" }));
        worker.emit({ type: "final", id: 1, text: "late" });
        expect(log).toEqual(["error:boom"]);
        expect(worker.terminated).toBe(true);
        expect(stt.status().state).toBe("error");
    });

    test("unloads the model after idling with no clients, never while one is connected", async () => {
        const { stt, worker } = await readyStt(10);
        const release = stt.retain();
        await Bun.sleep(30);
        expect(worker.terminated).toBe(false);
        release();
        await Bun.sleep(30);
        expect(worker.terminated).toBe(true);
        expect(stt.status().state).toBe("idle");
    });
});

describe("stt websocket", () => {
    function socket(engine: SpeechEngine) {
        const sent: Array<Record<string, unknown>> = [];
        const ws = {
            data: { engine } as SocketState,
            send: (m: string) => { sent.push(JSON.parse(m)); return 0; },
            closed: undefined as number | undefined,
            close(code?: number) { this.closed = code; },
        };
        return { ws, sent };
    }
    async function setup() {
        const workers: FakeWorker[] = [];
        const engine = new SpeechEngine(new StreamingStt("/m", () => { const w = new FakeWorker(); workers.push(w); return w as never; }, 60_000));
        const p = engine.stt.warm();
        workers[0]!.emit({ type: "ready" });
        await p;
        return { engine, worker: workers[0]! };
    }

    test("PCM16 frames reach the stream as float audio and events carry the client id", async () => {
        const { engine, worker } = await setup();
        const { ws, sent } = socket(engine);
        sttSocket.open(ws as never);
        sttSocket.message(ws as never, JSON.stringify({ type: "start", id: 7 }));
        sttSocket.message(ws as never, Buffer.from(new Int16Array([16384, -32768]).buffer));
        const audio = worker.posted.find((m) => m.type === "audio") as { pcm: Float32Array };
        expect([...audio.pcm]).toEqual([0.5, -1]);
        worker.emit({ type: "partial", id: 1, text: "(coughing) Run" });
        sttSocket.message(ws as never, JSON.stringify({ type: "end", id: 7 }));
        worker.emit({ type: "final", id: 1, text: "Run it (with tests)." });
        expect(sent).toEqual([
            { type: "partial", text: "Run", id: 7 },
            { type: "final", text: "Run it (with tests).", id: 7 },
        ]);
        engine.dispose();
    });

    test("a new start supersedes the old utterance; close cancels and releases", async () => {
        const { engine, worker } = await setup();
        const { ws, sent } = socket(engine);
        sttSocket.open(ws as never);
        sttSocket.message(ws as never, JSON.stringify({ type: "start", id: 1 }));
        sttSocket.message(ws as never, JSON.stringify({ type: "start", id: 2 }));
        worker.emit({ type: "final", id: 1, text: "old" });
        expect(sent).toEqual([]);
        expect(worker.posted.filter((m) => m.type === "cancel")).toEqual([{ type: "cancel", id: 1 }]);
        sttSocket.close(ws as never);
        expect(worker.posted.at(-1)).toEqual({ type: "cancel", id: 2 });
        worker.emit({ type: "final", id: 2, text: "after close" });
        expect(sent).toEqual([]);
        engine.dispose();
    });

    test("oversized or odd-length audio frames close the socket", async () => {
        const { engine } = await setup();
        const { ws } = socket(engine);
        sttSocket.open(ws as never);
        sttSocket.message(ws as never, JSON.stringify({ type: "start", id: 1 }));
        sttSocket.message(ws as never, Buffer.alloc(3));
        expect(ws.closed).toBe(1009);
        engine.dispose();
    });
});

// Opt-in: runs the real official WASM model in a worker. Set LIVE_STT_MODEL_ROOT to a directory
// that already holds (or may download) the small-streaming-en manifest files.
const root = process.env.LIVE_STT_MODEL_ROOT;
test.skipIf(!root)("real Moonshine streaming: partials while audio arrives, then a final", async () => {
    const stt = new StreamingStt(root!);
    try {
        await stt.warm();
        const pcm = new Float32Array(readFileSync(process.env.LIVE_STT_SAMPLE ?? "/tmp/mwasm/s0.f32").buffer.slice(0));
        const partials: string[] = [];
        const final = await new Promise<string>((resolve, reject) => {
            const s = stt.open({ partial: (t) => partials.push(t), final: resolve, error: (m) => reject(new Error(m)) });
            for (let i = 0; i < pcm.length; i += 1600) s.audio(pcm.slice(i, i + 1600));
            s.end();
        });
        expect(partials.length).toBeGreaterThan(1);
        expect(final.length).toBeGreaterThan(0);
    } finally {
        stt.dispose();
    }
}, 120_000);
