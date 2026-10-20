/**
 * Turn streaming assistant markdown into speakable sentences.
 *
 * The agent's reply grows token by token. SpeechChunker is fed the *full*
 * text so far and returns only newly completed sentences, so TTS can start on
 * sentence one while the model is still writing sentence three.
 */

/** Text blocks of an assistant message's content (no thinking, no tool calls). */
export function assistantText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
        .map((b) => b.text)
        .join("\n\n");
}

/**
 * Everything the assistant has said since the latest user message, as one
 * string. Prefix-stable while streaming, including when a keyless streaming
 * partial is swapped for its final message, so a chunker can follow it.
 */
export function replyText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
    let i = messages.length - 1;
    while (i >= 0 && messages[i]!.role !== "user") i--;
    const parts: string[] = [];
    for (let j = i + 1; j < messages.length; j++) {
        if (messages[j]!.role !== "assistant") continue;
        const t = assistantText(messages[j]!.content);
        if (t) parts.push(t);
    }
    return parts.join("\n\n");
}

const STOP_WORDS = new Set(["stop", "wait", "hold", "pause", "cancel", "no", "shut", "quiet", "enough", "hey"]);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * True when a transcript is mostly the agent's own recent speech picked up by
 * the mic (speakerphone echo the browser's AEC missed, common on phones).
 * ponytail: word-overlap heuristic; a user repeating the agent's words verbatim
 * while it talks is ignored. Upgrade to output-reference AEC if that matters.
 */
export function isEcho(transcript: string, spoken: string): boolean {
    const heard = words(transcript);
    if (!heard.length) return false;
    // Garbled echo fragments ("time and hit") rarely match; a short real
    // interruption is almost always a stop word.
    if (heard.length < 3) return !heard.some((w) => STOP_WORDS.has(w));
    const said = new Set(words(spoken));
    return heard.filter((w) => said.has(w)).length / heard.length >= 0.75;
}

/** Remove fenced code (complete or still-open) so it is never spoken. */
export function stripFences(md: string): string {
    const parts = md.split("```");
    // Even indexes are prose; odd indexes are inside a fence.
    return parts.filter((_, i) => i % 2 === 0).join("\n");
}

/** Markdown prose → plain words a TTS voice can read. */
export function toSpeakable(md: string): string {
    return md
        .split("\n")
        .filter((line) => !/^\s*\|/.test(line)) // tables
        .map((line) =>
            line
                .replace(/^\s{0,3}#{1,6}\s+/, "") // headings
                .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // list markers
                .replace(/^\s*>\s?/, ""), // quotes
        )
        .join("\n")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
        .replace(/\[\[[^\]]+\]\]/g, "") // sigils
        .replace(/https?:\/\/\S+/g, "a link")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2") // emphasis
        .replace(/[ \t]+/g, " ")
        .trim();
}

/** Sentence end, or a blank-line/newline paragraph break. */
const BOUNDARY = /[.!?…]["')\]]?(?=\s)|\n+/g;

export class SpeechChunker {
    #spokenUpTo = 0; // index into the fence-stripped text
    /** Fence-stripped offset where each sentence from the last push/flush ends. */
    ends: number[] = [];

    /** Feed the full text so far; returns sentences completed since last call. */
    push(fullText: string): string[] {
        const prose = stripFences(fullText);
        // An unclosed fence means the tail is code: don't treat it as prose yet.
        const openFence = (fullText.split("```").length - 1) % 2 === 1;
        // Text shrank (rehydrate, edit): stay silent rather than re-reading.
        if (prose.length < this.#spokenUpTo) this.#spokenUpTo = prose.length;
        let end = -1;
        BOUNDARY.lastIndex = this.#spokenUpTo;
        for (let m = BOUNDARY.exec(prose); m; m = BOUNDARY.exec(prose)) end = m.index + m[0].length;
        if (openFence) end = Math.max(end, prose.length);
        if (end <= this.#spokenUpTo) return (this.ends = []);
        return this.#take(prose, end);
    }

    /** The reply finished: speak whatever is left. */
    flush(fullText: string): string[] {
        const prose = stripFences(fullText);
        this.#spokenUpTo = Math.min(this.#spokenUpTo, prose.length);
        return this.#take(prose, prose.length);
    }

    #take(prose: string, end: number): string[] {
        const base = this.#spokenUpTo;
        const chunk = prose.slice(base, end);
        this.#spokenUpTo = end;
        const out: string[] = [];
        this.ends = [];
        let start = 0;
        const add = (stop: number) => {
            const s = toSpeakable(chunk.slice(start, stop));
            if (/[\p{L}\p{N}]/u.test(s)) {
                out.push(s);
                this.ends.push(base + stop);
            }
            start = stop;
        };
        BOUNDARY.lastIndex = 0;
        for (let m = BOUNDARY.exec(chunk); m; m = BOUNDARY.exec(chunk)) add(m.index + m[0].length);
        add(chunk.length);
        return out;
    }
}
