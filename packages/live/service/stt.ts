/**
 * Host side of the streaming STT worker: model lifecycle, stream identity,
 * and bounded buffering. Every stream gets a fresh id, and events for an id
 * the host no longer tracks (ended, cancelled, superseded) are dropped.
 *
 * The worker is a child process, not a Worker thread: terminating a Bun Worker
 * left the WASM module's pthreads and ~1 GB of memory alive (measured), while
 * killing a process reliably returns it. One process serves every stream.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelState } from "./engine.ts";

export const MOONSHINE_DIR = join(homedir(), ".pizzapi", "live", "models", "moonshine");
/** Unflushed audio the worker may lag behind by before a stream is failed. */
export const MAX_BACKLOG_SAMPLES = 16000 * 8;
/** Hard cap per utterance; the browser VAD already ends segments at 30 s. */
export const MAX_STREAM_SAMPLES = 16000 * 45;
export const MAX_STREAMS = 4;
export const IDLE_UNLOAD_MS = 10 * 60_000;
/** A load with no progress for this long is failed, so a stalled download can't pin "loading" forever. */
export const LOAD_STALL_MS = 2 * 60_000;

export type HostToWorker =
    | { type: "load"; root: string }
    | { type: "start"; id: number }
    | { type: "audio"; id: number; pcm: Float32Array }
    | { type: "end"; id: number }
    | { type: "cancel"; id: number }
    | { type: "batch"; id: number; pcm: Float32Array };

export type WorkerToHost =
    | { type: "progress"; file: string; pct: number }
    | { type: "ready" }
    | { type: "partial"; id: number; text: string }
    | { type: "final"; id: number; text: string }
    | { type: "ack"; id: number; samples: number }
    | { type: "error"; id?: number; message: string };

export interface StreamHandlers {
    partial(text: string): void;
    /** Called at most once, and never after error or cancel. */
    final(text: string): void;
    error(message: string): void;
}

export interface SttStream {
    audio(pcm: Float32Array): void;
    end(): void;
    cancel(): void;
}

interface Tracked {
    h: StreamHandlers;
    /** Messages held on this side until the model is ready; dropped with the stream on cancel. */
    pending: [HostToWorker, Transferable[]?][];
    backlog: number;
    total: number;
    ended: boolean;
}

type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
    onmessage: ((e: MessageEvent<WorkerToHost>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
};

/**
 * Run stt-worker.ts in its own process. BUN_BE_BUN makes a compiled `pizza`
 * binary behave as the bun CLI, so this also works when the runner is compiled.
 */
export function spawnWorkerProcess(): WorkerLike {
    let killed = false;
    const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (m: HostToWorker) => void proc.send(m),
        terminate: () => {
            killed = true;
            proc.kill();
        },
    } as WorkerLike;
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("./stt-worker.ts", import.meta.url))], {
        env: { ...process.env, BUN_BE_BUN: "1" },
        stdio: ["ignore", "inherit", "inherit"],
        serialization: "advanced",
        ipc: (m) => w.onmessage?.({ data: m } as MessageEvent<WorkerToHost>),
        onExit: (_p, code, signal) => {
            if (!killed) w.onerror?.({ message: `speech worker exited (${signal ?? code})` } as ErrorEvent);
        },
    });
    return w;
}

export class StreamingStt {
    #worker: WorkerLike | null = null;
    #ready: Promise<void> | null = null;
    #state: ModelState = "idle";
    #error: string | undefined;
    #progress: Record<string, number> = {};
    #streams = new Map<number, Tracked>();
    #nextId = 1;
    #refs = 0;
    #idle: ReturnType<typeof setTimeout> | undefined;
    #rejectLoad: ((e: Error) => void) | null = null;

    constructor(
        private root = MOONSHINE_DIR,
        private spawn: () => WorkerLike = spawnWorkerProcess,
        private idleMs = IDLE_UNLOAD_MS,
        private stallMs = LOAD_STALL_MS,
    ) {}

    status(): { state: ModelState; progress: Record<string, number>; error?: string } {
        return { state: this.#state, progress: { ...this.#progress }, ...(this.#error ? { error: this.#error } : {}) };
    }

    /** Load the model (downloading on first use). Safe to call repeatedly. */
    warm(): Promise<void> {
        if (this.#ready) return this.#ready;
        this.#state = "loading";
        this.#error = undefined;
        const worker = this.spawn();
        this.#worker = worker;
        this.#ready = new Promise<void>((resolve, reject) => {
            this.#rejectLoad = reject;
            let stall: ReturnType<typeof setTimeout> | undefined;
            const touch = () => {
                clearTimeout(stall);
                stall = setTimeout(() => {
                    if (this.#worker !== worker) return;
                    const message = "speech model load stalled";
                    this.#fail(message);
                    reject(new Error(message));
                }, this.stallMs);
                (stall as { unref?: () => void }).unref?.();
            };
            touch();
            worker.onmessage = (e) => {
                if (this.#worker !== worker) return; // superseded or unloaded
                const m = e.data;
                if (m.type === "progress" || m.type === "ready") touch();
                if (m.type === "ready") {
                    clearTimeout(stall);
                    this.#state = "ready";
                    this.#progress = {};
                    this.#rejectLoad = null;
                    for (const t of this.#streams.values()) for (const [m, tr] of t.pending.splice(0)) this.#post(m, tr);
                    this.#scheduleIdle();
                    resolve();
                } else if (m.type === "progress") {
                    if (m.pct >= 100) delete this.#progress[m.file];
                    else this.#progress[m.file] = Math.round(m.pct);
                } else if (m.type === "error" && m.id === undefined) {
                    this.#fail(m.message);
                    reject(new Error(m.message));
                } else {
                    this.#route(m);
                }
            };
            worker.onerror = (e) => {
                if (this.#worker !== worker) return;
                const message = e.message || "speech worker crashed";
                this.#fail(message);
                reject(new Error(message));
            };
        });
        this.#ready.catch(() => {});
        worker.postMessage({ type: "load", root: this.root } satisfies HostToWorker);
        return this.#ready;
    }

    /** Keep the model loaded while a client is connected. */
    retain(): () => void {
        this.#refs++;
        clearTimeout(this.#idle);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#refs--;
            this.#scheduleIdle();
        };
    }

    open(h: StreamHandlers): SttStream {
        const id = this.#nextId++;
        const fail = (message: string): SttStream => {
            queueMicrotask(() => h.error(message));
            return { audio() {}, end() {}, cancel() {} };
        };
        // After an idle unload or a crash, reload on demand; the worker queues this
        // stream behind the load, and the backlog limit still bounds buffered audio.
        if (this.#state === "idle" || this.#state === "error") this.warm().catch(() => {});
        if (!this.#worker) return fail("speech model is not ready");
        if (this.#streams.size >= MAX_STREAMS) return fail("too many simultaneous speech streams");
        const t: Tracked = { h, pending: [], backlog: 0, total: 0, ended: false };
        this.#streams.set(id, t);
        clearTimeout(this.#idle);
        this.#send(t, { type: "start", id });
        return {
            audio: (pcm) => {
                if (this.#streams.get(id) !== t || t.ended) return;
                t.backlog += pcm.length;
                t.total += pcm.length;
                if (t.backlog > MAX_BACKLOG_SAMPLES) return this.#abort(id, "speech recognition is falling behind");
                if (t.total > MAX_STREAM_SAMPLES) return this.#abort(id, "utterance too long");
                this.#send(t, { type: "audio", id, pcm }, [pcm.buffer]);
            },
            end: () => {
                if (this.#streams.get(id) !== t || t.ended) return;
                t.ended = true;
                this.#send(t, { type: "end", id });
            },
            cancel: () => {
                if (this.#streams.get(id) !== t) return;
                this.#drop(id);
                if (!t.pending.length) this.#post({ type: "cancel", id }); // else nothing reached the worker
            },
        };
    }

    /** One-shot transcription of a whole clip (legacy /api/stt). */
    transcribe(pcm: Float32Array): Promise<string> {
        return new Promise((resolve, reject) => {
            if (pcm.length > MAX_STREAM_SAMPLES) return reject(new Error("utterance too long"));
            if (this.#state === "idle" || this.#state === "error") this.warm().catch(() => {});
            if (!this.#worker) return reject(new Error("speech model is not ready"));
            if (this.#streams.size >= MAX_STREAMS) return reject(new Error("too many simultaneous speech streams"));
            const id = this.#nextId++;
            const t: Tracked = { h: { partial() {}, final: resolve, error: (m) => reject(new Error(m)) }, pending: [], backlog: 0, total: pcm.length, ended: true };
            this.#streams.set(id, t);
            clearTimeout(this.#idle);
            const copy = pcm.slice();
            this.#send(t, { type: "batch", id, pcm: copy }, [copy.buffer]);
        });
    }

    dispose() {
        clearTimeout(this.#idle);
        this.#unload("speech service stopped");
    }

    /** Post now if the model is ready, else hold it with the stream (bounded by its backlog limit). */
    #send(t: Tracked, m: HostToWorker, transfer?: Transferable[]) {
        if (this.#state === "ready") this.#post(m, transfer);
        else t.pending.push([m, transfer]);
    }

    #post(m: HostToWorker, transfer?: Transferable[]) {
        this.#worker?.postMessage(m, transfer ? { transfer } : undefined);
    }

    #route(m: WorkerToHost) {
        if (!("id" in m) || m.id === undefined) return;
        const t = this.#streams.get(m.id);
        if (!t) return; // late event for a finished or cancelled stream
        if (m.type === "ack") t.backlog = Math.max(0, t.backlog - m.samples);
        else if (m.type === "partial") t.h.partial(m.text);
        else if (m.type === "final") {
            this.#drop(m.id);
            t.h.final(m.text);
        } else if (m.type === "error") {
            this.#drop(m.id);
            t.h.error(m.message);
        }
    }

    #abort(id: number, message: string) {
        const t = this.#streams.get(id);
        if (!t) return;
        this.#drop(id);
        if (!t.pending.length) this.#post({ type: "cancel", id });
        t.h.error(message);
    }

    #drop(id: number) {
        this.#streams.delete(id);
        this.#scheduleIdle();
    }

    #fail(message: string) {
        this.#state = "error";
        this.#error = message;
        this.#unload(message);
        this.#state = "error";
    }

    /** Stop the worker and settle everything waiting on it exactly once. */
    #unload(reason = "speech model unloaded") {
        const worker = this.#worker;
        const streams = [...this.#streams.values()];
        const rejectLoad = this.#rejectLoad;
        this.#worker = null; // invalidates the old worker's late callbacks
        this.#ready = null;
        this.#rejectLoad = null;
        this.#streams.clear();
        this.#progress = {};
        if (this.#state !== "error") this.#state = "idle";
        worker?.terminate();
        rejectLoad?.(new Error(reason));
        for (const t of streams) t.h.error(reason);
    }

    #scheduleIdle() {
        clearTimeout(this.#idle);
        if (this.#refs > 0 || this.#streams.size > 0 || !this.#worker || this.#state === "loading") return;
        // ponytail: frees the ~1 GB model when Live is unused; reload costs a few seconds.
        this.#idle = setTimeout(() => this.#unload(), this.idleMs);
        (this.#idle as { unref?: () => void }).unref?.();
    }
}
