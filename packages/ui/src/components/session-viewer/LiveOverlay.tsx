import * as React from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, Loader2, Mic, MicOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveVoice, type LivePhase, type LiveVoiceOptions } from "@/lib/live-voice/useLiveVoice";
import { liveFeed } from "@/lib/live-voice/feed";
import { playCloseCue, playOpenCue, startWaitingCue } from "@/lib/live-voice/cues";

const PHASE_LABEL: Record<LivePhase, string> = {
    starting: "",
    listening: "Listening",
    hearing: "Listening",
    transcribing: "Got it…",
    thinking: "Working…",
    speaking: "Speaking",
    error: "Something went wrong",
};

export function LiveOverlay({ onClose: close, sessionName, ...opts }: LiveVoiceOptions & { onClose(): void; sessionName?: string }) {
    const live = useLiveVoice(opts);
    const onClose = React.useCallback(() => {
        playCloseCue();
        close();
    }, [close]);
    const orbRef = React.useRef<HTMLDivElement>(null);
    const ctx = opts.audioContext;

    const opened = React.useRef(false);
    React.useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        playOpenCue(ctx);
    }, [ctx]);

    const thinking = live.phase === "thinking";
    React.useEffect(() => (thinking ? startWaitingCue(ctx) : undefined), [thinking, ctx]);

    // Drive the orb straight from the audio level, without re-rendering.
    React.useEffect(() => {
        let raf = 0;
        let smooth = 0;
        const tick = () => {
            smooth += ((live.levelRef.current ?? 0) - smooth) * 0.25;
            if (orbRef.current) orbRef.current.style.transform = `scale(${1 + smooth * 0.35})`;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [live.levelRef]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const label = live.phase === "starting" ? live.status : live.muted ? "Muted" : PHASE_LABEL[live.phase];
    const feed = React.useMemo(() => liveFeed(opts.messages, opts.activeToolCalls, 8, live.revealed), [opts.messages, opts.activeToolCalls, live.revealed]);
    const feedRef = React.useRef<HTMLOListElement>(null);
    React.useEffect(() => {
        if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }, [feed]);

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Live voice chat"
            className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        >
            <div className="flex items-center justify-between px-4 py-3">
                <span className="truncate text-sm text-muted-foreground">{sessionName || "Live"}</span>
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-red-500">Live</span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6">
                <div className="relative flex size-40 shrink-0 items-center justify-center">
                    <div
                        ref={orbRef}
                        className={cn(
                            "size-32 rounded-full transition-[background,opacity] duration-500 will-change-transform",
                            live.phase === "speaking"
                                ? "bg-gradient-to-br from-sky-400 to-indigo-600"
                                : live.phase === "thinking" || live.phase === "transcribing"
                                  ? "animate-pulse bg-gradient-to-br from-indigo-400 to-fuchsia-600"
                                  : live.phase === "error"
                                    ? "bg-gradient-to-br from-red-400 to-red-700"
                                    : live.phase === "starting"
                                      ? "animate-pulse bg-muted"
                                      : "bg-gradient-to-br from-zinc-200 to-zinc-400 dark:from-zinc-500 dark:to-zinc-700",
                            live.muted && "opacity-40",
                        )}
                    />
                </div>

                <div className="flex min-h-28 w-full max-w-md flex-col items-center gap-3 text-center" aria-live="polite">
                    <p className="text-sm font-medium text-muted-foreground">{label}</p>
                    {live.error ? (
                        <p className="text-sm text-destructive">{live.error}</p>
                    ) : (
                        <>
                            {live.userCaption && (
                                // Live hypotheses change every half second; announce only the final text.
                                <p aria-hidden={live.userCaptionPartial || undefined} className={cn("line-clamp-2 text-sm text-muted-foreground", live.userCaptionPartial && "italic opacity-70")}>“{live.userCaption}”</p>
                            )}
                            {live.agentCaption && <p className="line-clamp-3 text-lg leading-snug">{live.agentCaption}</p>}
                        </>
                    )}
                </div>

                {feed.length > 0 && (
                    <ol
                        ref={feedRef}
                        aria-label="Recent activity"
                        className="flex max-h-56 w-full max-w-md shrink-0 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1 text-left text-xs [mask-image:linear-gradient(to_bottom,transparent,black_2rem)] [scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
                    >
                        {feed.map((item) => (
                            <li key={item.key} className="flex min-w-0 items-start gap-2">
                                {item.kind === "tool" ? (
                                    <>
                                        {item.state === "running" ? (
                                            <Loader2 className="mx-2 mt-0.5 size-3 shrink-0 animate-spin text-indigo-500" aria-label="Running" />
                                        ) : item.state === "error" ? (
                                            <AlertCircle className="mx-2 mt-0.5 size-3 shrink-0 text-destructive" aria-label="Failed" />
                                        ) : (
                                            <Check className="mx-2 mt-0.5 size-3 shrink-0 text-muted-foreground" aria-label="Done" />
                                        )}
                                        <span className="min-w-0">
                                            <span className={item.state === "running" ? "text-foreground" : "text-muted-foreground"}>{item.text}</span>
                                            {item.detail && <span className="block truncate font-mono text-[0.65rem] text-muted-foreground/70">{item.detail}</span>}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <span className="w-7 shrink-0 pt-px text-center text-[0.6rem] font-semibold uppercase text-muted-foreground">{item.kind === "user" ? "You" : "AI"}</span>
                                        <span className={cn("min-w-0", item.kind === "user" ? "line-clamp-2 text-muted-foreground" : "whitespace-pre-line text-foreground/80")}>{item.text}</span>
                                    </>
                                )}
                            </li>
                        ))}
                    </ol>
                )}
            </div>

            <div className="flex items-center justify-center gap-8 pb-8">
                <button
                    type="button"
                    onClick={() => live.setMuted(!live.muted)}
                    disabled={live.phase === "starting" || live.phase === "error"}
                    aria-pressed={live.muted}
                    aria-label={live.muted ? "Unmute microphone" : "Mute microphone"}
                    className={cn(
                        "flex size-16 items-center justify-center rounded-full border transition-colors disabled:opacity-40",
                        live.muted ? "border-foreground bg-foreground text-background" : "border-border bg-muted/50 hover:bg-muted",
                    )}
                >
                    {live.muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="End voice chat"
                    className="flex size-16 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-700"
                >
                    <X className="size-7" />
                </button>
            </div>
        </div>,
        document.body,
    );
}
