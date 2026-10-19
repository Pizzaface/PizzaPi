import * as React from "react";
import { resolveTunnelTarget } from "@/hooks/useTunnelSrc";
import { PlaybackQueue, startMic } from "./audio";
import { replyText, SpeechChunker, stripFences } from "./speech";
import { fetchTunnelWithFallback } from "./tunnel-fetch";
import { disconnected, SttSocket, sttSocketUrl } from "./stt-socket";

export type LivePhase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "error";

export interface LiveVoiceOptions {
    /** Unlocked in the Live button's click handler (iOS requires a user gesture). */
    audioContext: AudioContext;
    /** Requested synchronously from the Live button tap for mobile browser permission gating. */
    micStream: Promise<MediaStream>;
    sessionId: string;
    runnerId?: string;
    /** Port of the runner's `live` service. */
    port: number;
    messages: ReadonlyArray<{ role: string; content?: unknown }>;
    activeToolCalls?: ReadonlyMap<string, string>;
    agentActive: boolean;
    send(text: string, steer: boolean): Promise<boolean> | boolean;
    voice?: string;
}

export interface LiveVoiceState {
    phase: LivePhase;
    muted: boolean;
    setMuted(m: boolean): void;
    userCaption: string;
    /** True while userCaption is a live hypothesis that may still change. */
    userCaptionPartial: boolean;
    agentCaption: string;
    /** How much of the current reply (fence-stripped offset) has finished being spoken. */
    revealed: number;
    /** e.g. "Downloading voice models… 42%" while starting. */
    status: string;
    error: string | null;
    /** Current loudness 0–1 (mic while listening, voice while speaking), for animation. */
    levelRef: React.RefObject<number>;
}

const HEARTBEAT_MS = 30_000;

export function useLiveVoice(o: LiveVoiceOptions): LiveVoiceState {
    const [base, setBase] = React.useState<URL | null>(null);
    const [fallbackBase, setFallbackBase] = React.useState<URL | null>(null);
    const [ready, setReady] = React.useState(false);
    const [micReady, setMicReady] = React.useState(false);
    const [status, setStatus] = React.useState("Connecting…");
    const [error, setError] = React.useState<string | null>(null);
    const [hearing, setHearing] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    const [playing, setPlaying] = React.useState(false);
    const [muted, setMutedState] = React.useState(false);
    const [userCaption, setUserCaption] = React.useState("");
    const [userCaptionPartial, setUserCaptionPartial] = React.useState(false);
    const [sttOpen, setSttOpen] = React.useState(false);
    const [agentCaption, setAgentCaption] = React.useState("");
    // Infinity until the first spoken turn: text already there when Live opened is shown in full.
    const [revealed, setRevealed] = React.useState(Infinity);
    const turnRef = React.useRef(-1); // index of the user message the current reply answers
    const queuedEndRef = React.useRef(0); // reply offset where the last queued sentence ends
    const levelRef = React.useRef(0);

    // Latest props for audio callbacks that outlive renders.
    const live = React.useRef(o);
    live.current = o;
    const queueRef = React.useRef<PlaybackQueue | null>(null);
    const micRef = React.useRef<Awaited<ReturnType<typeof startMic>> | null>(null);
    const micStreamRef = React.useRef<MediaStream | null>(null);
    const chunkerRef = React.useRef<SpeechChunker | null>(null);
    const sttRef = React.useRef<SttSocket | null>(null);
    // Set by the mic effect: undo a speech-start pause when the utterance fails mid-speech.
    const sttFailedRef = React.useRef<(() => void) | null>(null);
    // The last committed caption, restored when a candidate utterance is dropped.
    const committedCaption = React.useRef("");

    // Permission is requested by the Live button's click handler. Observe the
    // result now, and stop the stream if the overlay closes before models load.
    React.useEffect(() => {
        let active = true;
        void o.micStream.then(
            (stream) => {
                if (!active) {
                    for (const track of stream.getTracks()) track.stop();
                    return;
                }
                micStreamRef.current = stream;
            },
            (e: unknown) => {
                if (active) setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied." : String(e));
            },
        );
        return () => {
            active = false;
            for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
            micStreamRef.current = null;
        };
    }, [o.micStream]);

    // 1. Resolve the tunnel to the live service.
    React.useEffect(() => {
        const ac = new AbortController();
        resolveTunnelTarget({ sessionId: o.sessionId, runnerId: o.runnerId, port: o.port }, ac.signal)
            .then(({ href, fallbackHref }) => {
                setBase(new URL(href.endsWith("/") ? href : `${href}/`, window.location.href));
                setFallbackBase(fallbackHref ? new URL(fallbackHref.endsWith("/") ? fallbackHref : `${fallbackHref}/`, window.location.href) : null);
            })
            .catch((e: unknown) => !ac.signal.aborted && setError(`Can't reach the voice service: ${e instanceof Error ? e.message : e}`));
        return () => ac.abort();
    }, [o.sessionId, o.runnerId, o.port]);

    const api = React.useCallback(
        (path: string, init?: RequestInit) =>
            fetchTunnelWithFallback(new URL(path, base!), fallbackBase ? new URL(path, fallbackBase) : null, init),
        [base, fallbackBase],
    );

    // 2. Load models, mark the session live (heartbeat), open the mic.
    React.useEffect(() => {
        if (!base) return;
        let cancelled = false;
        const markLive = (on: boolean) =>
            api(`api/session/${encodeURIComponent(o.sessionId)}/live`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ on }),
                keepalive: !on,
            }).catch(() => {});
        void markLive(true);
        const heartbeat = setInterval(() => void markLive(true), HEARTBEAT_MS);

        void (async () => {
            try {
                await api("api/warm", { method: "POST" });
                for (;;) {
                    const s = (await (await api("api/status")).json()) as { stt: string; tts: string; progress: Record<string, number>; error?: string };
                    if (cancelled) return;
                    if (s.stt === "error" || s.tts === "error") throw new Error(s.error ?? "voice models failed to load");
                    if (s.stt === "ready" && s.tts === "ready") break;
                    const pct = Object.values(s.progress);
                    setStatus(pct.length ? `Downloading voice models… ${Math.round(pct.reduce((a, b) => a + b, 0) / pct.length)}%` : "Loading voice models…");
                    await new Promise((r) => setTimeout(r, 1000));
                }
                if (cancelled) return;
                setReady(true);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();

        return () => {
            cancelled = true;
            clearInterval(heartbeat);
            void markLive(false);
        };
    }, [base, api, o.sessionId]);

    const speak = React.useCallback(
        (sentence: string, end: number) => {
            queueRef.current?.enqueue(async () => {
                const r = await api("api/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: sentence, voice: live.current.voice }),
                });
                if (!r.ok) throw new Error(`tts ${r.status}`);
                return r.arrayBuffer();
            }, () => {
                setAgentCaption(sentence);
                setRevealed(end); // show the sentence in the feed as it starts playing
            });
        },
        [api],
    );

    // 3a. Streaming STT socket, once models are ready.
    React.useEffect(() => {
        if (!ready || !base) return;
        const stt = new SttSocket(
            [sttSocketUrl(base), ...(fallbackBase ? [sttSocketUrl(fallbackBase)] : [])],
            {
                partial: (text) => {
                    if (!text) return;
                    setUserCaption(text);
                    setUserCaptionPartial(true);
                },
                openChange: setSttOpen,
                failed: () => sttFailedRef.current?.(),
            },
        );
        sttRef.current = stt;
        return () => {
            stt.close();
            sttRef.current = null;
            setSttOpen(false);
        };
    }, [ready, base, fallbackBase]);

    // 3. Mic + playback, once models are ready.
    React.useEffect(() => {
        if (!ready) return;
        const ctx = o.audioContext;
        const queue = new PlaybackQueue(
            ctx,
            () => {
                setPlaying(false);
                // Queue drained (not just paused): everything queued has been spoken or skipped.
                if (!queue.busy) setRevealed(queuedEndRef.current);
            },
            () => setPlaying(true),
        );
        queueRef.current = queue;
        let stopped = false;
        const ac = new AbortController();
        const restoreCaption = () => {
            setUserCaption(committedCaption.current);
            setUserCaptionPartial(false);
        };
        // Don't keep the reply paused until the VAD ends the turn; finish() reports the error.
        sttFailedRef.current = () => {
            if (stopped) return;
            restoreCaption();
            queue.resume();
        };
        setMicReady(false);
        setStatus("Loading speech detector…");

        startMic(ctx, {
            onError: (e) => {
                if (stopped) return;
                queue.resume();
                setHearing(false);
                setError(e instanceof Error ? e.message : String(e));
            },
            onLevel: (l) => {
                if (!queue.playing) levelRef.current = Math.min(1, l * 8);
            },
            onSpeechStart: () => {
                setHearing(true);
                // Noise is only a candidate interruption. Preserve audio until
                // transcription confirms that the user actually said something.
                queue.pause();
                sttRef.current?.begin();
            },
            onAudio: (samples) => sttRef.current?.audio(samples),
            onDiscard: () => {
                setHearing(false);
                sttRef.current?.cancel();
                restoreCaption();
                queue.resume();
            },
            onSpeechEnd: async () => {
                setHearing(false);
                setTranscribing(true);
                try {
                    const stt = sttRef.current;
                    if (!stt) throw disconnected("Speech service is not connected.");
                    const text = await stt.finish();
                    if (stopped) return;
                    if (!text.trim()) {
                        restoreCaption();
                        queue.resume();
                        return;
                    }
                    queue.clear();
                    committedCaption.current = text;
                    setUserCaption(text);
                    setUserCaptionPartial(false);
                    setAgentCaption("");
                    // Don't hold the "transcribing" phase, or the mic, open for the delivery ack:
                    // the user can keep talking while the message is delivered.
                    setTranscribing(false);
                    const notSent = () => {
                        if (!stopped && committedCaption.current === text) setUserCaption(`${text} (not sent)`);
                    };
                    void Promise.resolve(live.current.send(text, live.current.agentActive)).then((ok) => ok || notSent(), notSent);
                } catch (e) {
                    const name = e instanceof Error ? e.name : "";
                    if (!stopped) {
                        restoreCaption();
                        queue.resume();
                        // Cancelled (mute) or dropped socket: not fatal. A dropped socket reconnects
                        // by itself; the utterance is lost rather than replayed, so it is never sent twice.
                        if (name !== "AbortError" && name !== "SttDisconnected") setError(e instanceof Error ? e.message : String(e));
                    }
                } finally {
                    if (!stopped) setTranscribing(false);
                }
            },
        }, o.micStream, ac.signal).then(
            (mic) => {
                if (stopped) mic.stop();
                else {
                    micRef.current = mic;
                    setMicReady(true);
                }
            },
            (e: unknown) => {
                if (!stopped) setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied." : String(e));
            },
        );

        let raf = 0;
        const tick = () => {
            if (queue.playing) levelRef.current = Math.min(1, queue.level() * 4);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return () => {
            stopped = true;
            ac.abort();
            cancelAnimationFrame(raf);
            queue.clear();
            micRef.current?.stop();
            micRef.current = null;
            queueRef.current = null;
            sttFailedRef.current = null;
        };
    }, [ready, api, o.audioContext]);

    // 4. Speak new sentences of the reply as they stream in. Text written before
    // a tool call is complete, so flush it instead of waiting for more text.
    const toolRunning = (o.activeToolCalls?.size ?? 0) > 0;
    React.useEffect(() => {
        const text = replyText(o.messages);
        const turn = o.messages.findLastIndex((m) => m.role === "user");
        if (!chunkerRef.current) {
            // Opening Live mid-reply: don't read out what's already on screen.
            chunkerRef.current = new SpeechChunker();
            chunkerRef.current.flush(text);
            queuedEndRef.current = stripFences(text).length;
            turnRef.current = turn;
            return;
        }
        // A new turn restarts reply offsets; hide its text until it is spoken.
        if (turn !== turnRef.current) {
            turnRef.current = turn;
            queuedEndRef.current = 0;
            setRevealed(0);
        }
        if (!ready) return;
        const c = chunkerRef.current;
        const queue = (sentences: string[]) =>
            sentences.forEach((s, i) => {
                speak(s, c.ends[i]!);
                queuedEndRef.current = c.ends[i]!;
            });
        queue(c.push(text));
        if (!o.agentActive || toolRunning) queue(c.flush(text));
    }, [o.messages, o.agentActive, toolRunning, ready, speak]);

    React.useEffect(() => () => void o.audioContext.close().catch(() => {}), [o.audioContext]);

    const setMuted = React.useCallback((m: boolean) => {
        setMutedState(m);
        micRef.current?.setMuted(m);
        // Muting also withdraws an utterance still waiting for its final text.
        if (m) sttRef.current?.cancel();
    }, []);

    const phase: LivePhase = error
        ? "error"
        : !ready || !micReady || !sttOpen
          ? "starting"
          : hearing
            ? "hearing"
            : transcribing
              ? "transcribing"
              : playing
                ? "speaking"
                : o.agentActive
                  ? "thinking"
                  : "listening";

    const shownStatus = ready && micReady && !sttOpen ? "Connecting to speech service…" : status;
    return { phase, muted, setMuted, userCaption, userCaptionPartial, agentCaption, revealed, status: shownStatus, error, levelRef };
}
