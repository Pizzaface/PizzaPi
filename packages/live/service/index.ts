/**
 * Live voice runner service. The web UI's Live overlay talks to this over the
 * tunnel: speech in (/api/stt), speech out (/api/tts), and the per-session
 * "live" flag the session extension reads.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";
import { setLive } from "../flags.ts";
import { DEFAULT_VOICE, SpeechEngine } from "./engine.ts";
import { decodeWav, resample } from "./wav.ts";

const MAX_TTS_CHARS = 1000;
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });

export async function handleRequest(req: Request, engine: SpeechEngine, indexHtml: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = new URL(req.url).pathname;
    // Match our routes by suffix in case a tunnel prefix (itself under /api/) survives.
    const route = path.match(/\/api\/(?:stt|tts|status|warm|voices|session\/[^/]+\/live)$/)?.[0] ?? path;

    try {
        if (route === "/api/status" && req.method === "GET") return json(engine.status());

        if (route === "/api/warm" && req.method === "POST") {
            engine.warm();
            return json(engine.status());
        }

        if (route === "/api/voices" && req.method === "GET") return json({ voices: await engine.voices(), default: DEFAULT_VOICE });

        if (route === "/api/stt" && req.method === "POST") {
            const wav = decodeWav(new Uint8Array(await req.arrayBuffer()));
            const text = await engine.transcribe(resample(wav.samples, wav.sampleRate, 16000));
            return json({ text });
        }

        if (route === "/api/tts" && req.method === "POST") {
            const body = (await req.json()) as { text?: unknown; voice?: unknown; speed?: unknown };
            const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
            if (!text) return json({ error: "text required" }, 400);
            const voice = typeof body.voice === "string" && /^[a-z]{2}_[a-z]+$/.test(body.voice) ? body.voice : DEFAULT_VOICE;
            const speed = typeof body.speed === "number" && body.speed >= 0.5 && body.speed <= 2 ? body.speed : 1;
            const wav = await engine.synthesize(text, voice, speed);
            return new Response(wav, { headers: { ...CORS, "Content-Type": "audio/wav" } });
        }

        const live = route.match(/^\/api\/session\/([^/]+)\/live$/);
        if (live && req.method === "POST") {
            const { on } = (await req.json()) as { on?: unknown };
            if (!setLive(decodeURIComponent(live[1]!), on === true)) return json({ error: "bad session id" }, 400);
            return json({ ok: true });
        }
    } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    if (req.method === "GET" && route === path) {
        return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
}

class LiveService {
    get id() {
        return "live";
    }
    #server: Server<undefined> | null = null;
    #engine = new SpeechEngine();

    init(_socket: unknown, { announcePanel }: { announcePanel?: (port: number) => void }) {
        const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel", "index.html"), "utf-8");
        // idleTimeout: the first STT/TTS call can wait on a model load well past Bun's 10s default.
        this.#server = Bun.serve({ port: 0, idleTimeout: 240, fetch: (req) => handleRequest(req, this.#engine, indexHtml) });
        announcePanel?.(this.#server.port!);
    }

    handleSessionEnded(sessionId: string) {
        setLive(sessionId, false);
    }

    dispose() {
        this.#server?.stop(true);
        this.#server = null;
    }
}

export default LiveService;
