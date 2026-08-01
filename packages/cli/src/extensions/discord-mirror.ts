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

/** Discord's hard limit is 2000 chars; the service re-chunks, this just bounds the payload. */
const MAX_MIRROR_CHARS = 8_000;

/** Trim to one line and cap length for a compact tool-activity line. */
function summarize(value: unknown, max = 120): string {
    const s = String(value ?? "").split("\n")[0].trim();
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Render a compact one-line summary of a tool call for the Discord thread.
 * Falls back to just the tool name for tools we don't special-case.
 */
export function renderToolCallLine(toolName: unknown, input: any): string {
    const t = typeof toolName === "string" && toolName ? toolName : "tool";
    const i = input && typeof input === "object" ? input : {};
    const code = (v: unknown) => (v ? ` \`${summarize(v)}\`` : "");
    switch (t) {
        case "bash": return `\u2699\uFE0F \`bash\`${code(i.command)}`;
        case "read": return `\uD83D\uDCD6 \`read\`${code(i.path)}`;
        case "write": return `\u270F\uFE0F \`write\`${code(i.path)}`;
        case "edit": return `\u270F\uFE0F \`edit\`${code(i.path)}`;
        case "grep": return `\uD83D\uDD0D \`grep\`${code(i.pattern)}`;
        case "find": return `\uD83D\uDD0D \`find\`${code(i.pattern ?? i.query)}`;
        case "ls": return `\uD83D\uDCC1 \`ls\`${code(i.path)}`;
        default: return `\uD83D\uDD27 \`${t}\``;
    }
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

/**
 * Pull the text of the last assistant message out of a run's message list.
 * Mirrors the extraction in remote/lifecycle-handlers.ts.
 */
export function lastAssistantText(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as any;
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        const text = msg.content
            .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string" && c.text)
            .map((c: any) => c.text as string)
            .join("\n")
            .trim();
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
        // final turn. The service coalesces these into batched messages.
        pi.on("tool_call" as any, (event: any) => {
            emit("discord_activity", { line: renderToolCallLine(event?.toolName, event?.input) });
        });
        pi.on("tool_result" as any, (event: any) => {
            if (!event?.isError) return; // successes are implied by the next step; only surface failures
            emit("discord_activity", { line: `\u274C \`${event?.toolName ?? "tool"}\` failed` });
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
