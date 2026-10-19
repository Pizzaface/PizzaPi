import { summarizeToolActivity } from "@/components/session-viewer/activity-summary";
import { assistantText, stripFences } from "./speech";

export type FeedItem =
    | { kind: "user" | "agent"; key: string; text: string }
    | { kind: "tool"; key: string; text: string; detail?: string; state: "running" | "done" | "error" };

type Msg = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };

const oneLine = (s: string, max = 140) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/**
 * The last few turns as a transcript: what was said and which tools ran.
 * The current reply shows only its first `revealed` characters (offset into
 * replyText with code fences stripped), so it fills in as it is spoken.
 */
export function liveFeed(
    messages: ReadonlyArray<Msg>,
    running: ReadonlyMap<string, string> | undefined,
    limit = 8,
    revealed = Infinity,
): FeedItem[] {
    const turn = messages.findLastIndex((m) => m.role === "user");
    let pos = 0; // offset of the next assistant text within the current reply
    const failed = new Set<string>();
    for (const m of messages) if (m.role === "toolResult" && m.isError && m.toolCallId) failed.add(m.toolCallId);
    const items: FeedItem[] = [];
    // Only the tail is shown; scan back far enough to fill it.
    // Start at the current turn if it is earlier, so reply offsets add up.
    for (let i = Math.max(0, Math.min(messages.length - limit * 3, turn + 1)); i < messages.length; i++) {
        const m = messages[i]!;
        if (m.role === "user") {
            const text = assistantText(m.content);
            if (text.trim()) items.push({ kind: "user", key: `${i}`, text: oneLine(text) });
        } else if (m.role === "assistant") {
            let text = assistantText(m.content);
            if (i > turn && text && revealed !== Infinity) {
                const prose = stripFences(text);
                text = prose.slice(0, Math.max(0, revealed - pos));
                pos += prose.length + 2; // replyText joins messages with "\n\n"
            }
            text = text.replace(/\n{3,}/g, "\n\n").trim();
            if (text) items.push({ kind: "agent", key: `${i}`, text });
            if (!Array.isArray(m.content)) continue;
            for (const b of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
                if (b?.type !== "toolCall") continue;
                const s = summarizeToolActivity(b.name, b.arguments);
                const id = b.id ?? "";
                const state = running?.has(id) ? "running" : failed.has(id) ? "error" : "done";
                items.push({ kind: "tool", key: `${i}:${id}`, text: s.label, detail: s.detail, state });
            }
        }
    }
    return items.slice(-limit);
}
