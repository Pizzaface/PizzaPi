/**
 * Session-side half of Live mode: while the user is talking to this session
 * by voice, tell the agent its replies will be spoken aloud.
 */
import { isLive } from "./flags.ts";

export const VOICE_PROMPT =
    "\n\n<live-voice>\nThe user is talking to you by voice right now. Your reply text is read aloud, and their messages are speech transcripts (expect transcription errors, so infer intent). " +
    "Keep replies concise and conversational, like a colleague on a call. Lead with the answer. Don't use markdown headings, tables or bullet lists in spoken replies. " +
    "Don't go silent while working: briefly acknowledge the request and say what you're starting, then give short spoken progress updates at meaningful milestones, especially before a long wait and after it finishes. If a task takes more than a few seconds, keep the user informed rather than saving everything for the end. Don't narrate every tool call or repeat unchanged status. " +
    "Never read code, paths, diffs or command output aloud. Say what you're checking or doing in plain speech, then summarize the verified result and anything still in progress. Code blocks you write still appear on screen.\n</live-voice>";

// pi's ExtensionAPI type comes from the host; the package deliberately has no pi dependency.
export default function liveVoice(pi: any, home?: string) {
    pi.on("before_agent_start", (event: { systemPrompt: string }) => {
        if (!isLive(process.env.PIZZAPI_SESSION_ID, home)) return;
        return { systemPrompt: event.systemPrompt + VOICE_PROMPT };
    });
}
