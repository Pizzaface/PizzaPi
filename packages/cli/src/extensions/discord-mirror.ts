/**
 * Discord mirror extension — forwards each settled assistant turn to the
 * daemon-scoped `discord` runner service over `service_message`.
 *
 * This is the *outbound* half of the Discord bridge. The inbound half (Discord
 * message -> session) is owned by the service, which posts to
 * `/api/sessions/:id/trigger`. See the "connectivity services" section of
 * docs/customization/runner-services.mdx.
 *
 * The session deliberately knows nothing about Discord: it emits one envelope
 * per settled turn and the service drops it if this session has no mapped
 * thread. That keeps thread mapping in exactly one place (the service) instead
 * of duplicating it into every session.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
    getRelaySocket as getRelaySocketDefault,
    getRelaySessionId as getRelaySessionIdDefault,
} from "./remote.js";
import { sanitizeQuestions } from "./remote-ask-user.js";

/** Discord's hard limit is 2000 chars; the service re-chunks, this just bounds the payload. */
const MAX_MIRROR_CHARS = 8_000;

/** Mid-turn assistant text rides the activity feed as a preview line, not the full post — keep it short. */
const MAX_MIDTURN_CHARS = 300;

/** Per-field cap on tool_call input shipped over the relay — big file/bash content stays local. */
const MAX_INPUT_FIELD_CHARS = 500;

/**
 * Shallow-copy a tool call's input, capping any long string field so a
 * `write` of a huge file (or similar) doesn't ship megabytes over the relay.
 * No per-tool-name knowledge here — rendering happens in the Discord
 * package, which can format *any* tool generically instead of this
 * extension needing a hardcoded allowlist that drifts from the real tool set.
 */
export function sanitizeToolInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object") return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = typeof v === "string" && v.length > MAX_INPUT_FIELD_CHARS
            ? `${v.slice(0, MAX_INPUT_FIELD_CHARS)}…`
            : v;
    }
    return out;
}

export interface DiscordMirrorDeps {
    getRelaySocket: typeof getRelaySocketDefault;
    getRelaySessionId: typeof getRelaySessionIdDefault;
    newId: () => string;
}

const defaultDeps: DiscordMirrorDeps = {
    getRelaySocket: getRelaySocketDefault,
    getRelaySessionId: getRelaySessionIdDefault,
    newId: randomUUID,
};

/** Count added/removed lines from a unified diff patch (the edit tool's `details.patch`). Null if unparsable/empty. */
function diffStatsFromPatch(patch: unknown): { added: number; removed: number } | null {
    if (typeof patch !== "string" || !patch) return null;
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
    }
    return added || removed ? { added, removed } : null;
}

/** Extract one assistant message's text content, joining its text blocks. Null for non-assistant or textless (tool-only) messages. */
function assistantMessageText(msg: unknown): string | null {
    const m = msg as any;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return null;
    const text = m.content
        .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string" && c.text)
        .map((c: any) => c.text as string)
        .join("\n")
        .trim();
    return text || null;
}

/**
 * Pull the text of the last assistant message out of a run's message list.
 * Mirrors the extraction in remote/lifecycle-handlers.ts.
 */
export function lastAssistantText(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const text = assistantMessageText(messages[i]);
        if (text) return text.length > MAX_MIRROR_CHARS ? `${text.slice(0, MAX_MIRROR_CHARS)}\n…(truncated)` : text;
    }
    return null;
}

export function createDiscordMirrorExtension(deps: DiscordMirrorDeps = defaultDeps): ExtensionFactory {
    return (pi) => {
        // agent_end fires after every attempt (including retried ones); hold the
        // text and only publish once agent_settled confirms the turn is final.
        let pending: string | null = null;

        // Fire-and-forget emit of one envelope to the discord service. A dropped
        // mirror is cosmetic; blocking the turn on Discord's availability is not.
        // `id` lets the service dedupe at-least-once relay delivery.
        const emit = (type: string, payload: Record<string, unknown>) => {
            const conn = deps.getRelaySocket();
            const sessionId = deps.getRelaySessionId();
            if (!conn || !sessionId) return;
            try {
                conn.socket.emit("service_message" as any, {
                    serviceId: "discord",
                    type,
                    payload: { id: deps.newId(), sessionId, ...payload },
                });
            } catch {
                // Relay socket mid-reconnect — skip.
            }
        };

        // Stream tool activity so the thread shows work-in-progress, not just the
        // final turn. The service coalesces these into ONE edited status message.
        //
        // AskUserQuestion and plan_mode block the turn waiting on the human, so
        // they get first-class treatment (a poll / a plan card) instead of a
        // terse activity line — the service turns these envelopes into an
        // interactive prompt and routes the reply back as the tool's answer.
        pi.on("tool_call" as any, (event: any) => {
            const name = event?.toolName;
            if (name === "AskUserQuestion") {
                emit("discord_ask", {
                    toolCallId: event?.toolCallId,
                    questions: sanitizeQuestions((event?.input ?? {}) as any),
                });
                return;
            }
            if (name === "plan_mode") {
                const input = (event?.input ?? {}) as Record<string, unknown>;
                emit("discord_plan", {
                    toolCallId: event?.toolCallId,
                    title: typeof input.title === "string" ? input.title : "",
                    description: typeof input.description === "string" ? input.description : null,
                    steps: Array.isArray(input.steps) ? input.steps : [],
                });
                return;
            }
            // edit's diff stats aren't known until it finishes — the tool_result
            // handler below emits its activity line (with +/- counts) instead.
            if (name === "edit") return;
            if (name === "write") {
                // write replaces the whole file — there's no "before" to diff against
                // (unlike edit, which gets a real patch back), so just count the
                // lines going in.
                const content = typeof event?.input?.content === "string" ? event.input.content : "";
                const input = sanitizeToolInput(event?.input);
                if (content) input.added = content.split("\n").length;
                emit("discord_activity", { toolName: name, input });
                return;
            }
            emit("discord_activity", { toolName: name, input: sanitizeToolInput(event?.input) });
        });

        // Assistant text that lands *between* tool calls ("let me check that file
        // first…") would otherwise be silently dropped — only the run's final
        // message gets mirrored, via agent_end/agent_settled below. Feed every
        // intermediate assistant message into the same activity trail as tool
        // calls so the thread shows the model's reasoning as it happens, not
        // just the finished answer.
        pi.on("message_end" as any, (event: any) => {
            const text = assistantMessageText(event?.message);
            if (!text) return;
            const line = text.length > MAX_MIDTURN_CHARS ? `${text.slice(0, MAX_MIDTURN_CHARS)}…` : text;
            emit("discord_activity", { line: `💬 ${line}` });
        });

        // set_session_name -> Discord thread title. session_info_changed fires
        // whenever the session's display name changes; the service renames the
        // bound thread to match.
        pi.on("session_info_changed" as any, (event: any) => {
            const name = typeof event?.name === "string" ? event.name.trim() : "";
            if (name) emit("discord_rename", { name });
        });
        pi.on("tool_result" as any, (event: any) => {
            if (event?.isError) {
                emit("discord_activity", { line: `\u274C \`${event?.toolName ?? "tool"}\` failed` });
                return;
            }
            // AskUserQuestion just finished (answered or cancelled) via web, TUI,
            // or Discord itself — tell the service to close its poll so it never
            // sits open on an already-resolved question.
            if (event?.toolName === "AskUserQuestion") {
                emit("discord_ask_resolved", { toolCallId: event?.toolCallId });
                return;
            }
            if (event?.toolName === "edit") {
                const stats = diffStatsFromPatch((event?.details as any)?.patch);
                const input = stats ? { path: event?.input?.path, ...stats } : sanitizeToolInput(event?.input);
                emit("discord_activity", { toolName: "edit", input });
            }
        });

        pi.on("agent_end" as any, (event: any) => {
            const text = lastAssistantText(event?.messages);
            if (text) pending = text;
        });

        pi.on("agent_settled" as any, () => {
            const content = pending;
            pending = null;
            if (!content) return;
            emit("discord_post", { content });
        });
    };
}

export const discordMirrorExtension: ExtensionFactory = createDiscordMirrorExtension();
