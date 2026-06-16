/**
 * Helpers for building a compact, plain-text transcript from session entries
 * and turn artifacts. Used by the `/goal` LLM evaluator.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    AssistantMessage,
    TextContent,
    ToolResultMessage,
    UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TRANSCRIPT_MAX_CHARS = 60_000;

/**
 * Extract readable text from an AgentMessage, ignoring images, tool calls,
 * and custom message types.
 */
export function extractAgentMessageText(message: AgentMessage): string {
    if (!("role" in message)) return "";

    const role = message.role;
    if (role === "user") {
        return extractUserText(message as UserMessage);
    }
    if (role === "assistant") {
        return extractAssistantText(message as AssistantMessage);
    }
    if (role === "toolResult") {
        return extractToolResultText(message as ToolResultMessage);
    }
    return "";
}

function extractUserText(message: UserMessage): string {
    if (typeof message.content === "string") return message.content;
    return extractTextBlocks(message.content);
}

function extractAssistantText(message: AssistantMessage): string {
    return extractTextBlocks(message.content);
}

function extractToolResultText(message: ToolResultMessage): string {
    return extractTextBlocks(message.content);
}

function extractTextBlocks(content: Array<TextContent | { type: string; text?: unknown }>): string {
    return content
        .filter((c): c is TextContent => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
}

/**
 * Extract a plain-text snapshot of the latest turn for evaluation.
 *
 * This is a best-effort concatenation of assistant message text and tool
 * result text. It intentionally avoids depending on upstream message types
 * so it can be unit-tested.
 */
export function extractLatestTurnText(payload: {
    assistantText?: string;
    assistantContent?: string | Array<{ type: string; text?: string }>;
    toolResults?: Array<{ content?: Array<{ type: string; text?: string }>; text?: string }>;
}): string {
    const parts: string[] = [];
    if (payload.assistantText) {
        parts.push(payload.assistantText);
    } else if (payload.assistantContent) {
        if (typeof payload.assistantContent === "string") {
            parts.push(payload.assistantContent);
        } else {
            const joined = extractTextBlocks(payload.assistantContent);
            if (joined) parts.push(joined);
        }
    }

    for (const tool of payload.toolResults ?? []) {
        if (tool.text) {
            parts.push(tool.text);
            continue;
        }
        const joined = extractTextBlocks(tool.content ?? []);
        if (joined) parts.push(joined);
    }

    return parts.join("\n\n");
}

/**
 * Build a compact transcript from session message entries.
 *
 * ⚠️ PRIVACY WARNING: this transcript contains the full text of the session
 * (user messages, assistant replies, and tool outputs) and is sent to the
 * configured evaluator LLM. Do not include secrets, credentials, or other
 * sensitive data in goal conditions or in messages you expect to remain private.
 * A best-effort regex redacts common env-var-style secrets, but it is not a
 * guarantee. Review the content before enabling LLM-based evaluation.
 *
 * The transcript includes user, assistant, and tool-result messages as plain
 * text. It is capped to `maxChars` (default 60,000) to keep evaluator costs
 * bounded; older content is truncated from the front so the latest turns are
 * preserved.
 */
export function buildTranscript(entries: SessionEntry[], maxChars = TRANSCRIPT_MAX_CHARS): string {
    const lines: string[] = [];

    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const text = extractAgentMessageText(entry.message).trim();
        if (!text) continue;

        const role = entry.message.role;
        let prefix: string;
        if (role === "user") {
            prefix = "User:";
        } else if (role === "assistant") {
            prefix = "Assistant:";
        } else if (role === "toolResult") {
            const tool = entry.message as ToolResultMessage;
            prefix = `Tool (${tool.toolName}):`;
        } else {
            prefix = `${String(role)}:`;
        }

        lines.push(`${prefix}\n${text}`);
    }

    let transcript = lines.join("\n\n");

    // Best-effort redaction of common env-var secrets before sending to the
    // evaluator. This is a safety net, not a replacement for avoiding secrets
    // in session text. Values are replaced with [REDACTED] while preserving the
    // key and separator so the transcript structure stays intact.
    transcript = redactEnvVarSecrets(transcript);

    if (transcript.length > maxChars) {
        transcript = transcript.slice(-maxChars);
        const firstNewline = transcript.indexOf("\n");
        if (firstNewline > 0) {
            transcript = transcript.slice(firstNewline + 1);
        }
        transcript = `...truncated...\n${transcript}`;
    }

    return transcript;
}

/** Known secret-looking environment variable names to redact from transcripts. */
const REDACTED_ENV_VARS = [
    "PIZZAPI_AUTH_TOKEN",
    "PIZZAPI_API_KEY",
    "PI_API_KEY",
    "PI_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "COHERE_API_KEY",
    "MISTRAL_API_KEY",
    "OPENROUTER_API_KEY",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "DOCKER_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY",
].join("|");

/**
 * Redact values that follow common env-var patterns (KEY=value, KEY: value,
 * "KEY": "value", export KEY=value). Keeps the key and separator intact.
 */
function redactEnvVarSecrets(transcript: string): string {
    const pattern = new RegExp(
        `\\b(${REDACTED_ENV_VARS})\\b\\s*([:=])\\s*[^\\s\\n]+`,
        "g",
    );
    return transcript.replace(pattern, "$1$2[REDACTED]");
}
