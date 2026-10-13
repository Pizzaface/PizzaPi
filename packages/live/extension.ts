/**
 * Session-side half of Live mode: while the user is talking to this session
 * by voice, tell the agent its replies will be spoken aloud.
 */
import { isLive } from "./flags.ts";

export const VOICE_PROMPT =
    "\n\n<live-voice>\nThe user is talking to you by voice right now. Your reply text is read aloud, and their messages are speech transcripts (expect transcription errors, so infer intent). " +
    "Keep replies short and conversational, a few sentences, like a colleague on a call. Lead with the answer. Don't use markdown headings, tables or bullet lists in spoken replies. " +
    "Never read code, paths, diffs or command output aloud. Do the work with your tools as usual, then summarize what you did and what you found in plain speech. Code blocks you write still appear on screen.\n</live-voice>";

// pi's ExtensionAPI type comes from the host; the package deliberately has no pi dependency.
export default function liveVoice(pi: any, home?: string) {
    pi.on("before_agent_start", (event: { systemPrompt: string }) => {
        if (!isLive(process.env.PIZZAPI_SESSION_ID, home)) return;
        return { systemPrompt: event.systemPrompt + VOICE_PROMPT };
    });
}
