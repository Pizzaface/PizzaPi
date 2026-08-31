import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { runGit } from "../config/system-prompt.js";

/**
 * Git-branch extension — injects the current git branch into the system prompt.
 *
 * The baked-in prompt deliberately omits the branch: it's computed at boot and
 * goes stale the moment anything checks out another branch (dispatch machinery,
 * the git panel, the agent itself). Here the branch is looked up ONCE, on the
 * first turn of a session — after any dispatch-time checkout — and the same
 * value is injected on every turn. Mid-session branch switches stay visible in
 * the conversation history, so the prompt keeps describing where the session
 * started.
 */

/** Insert a `Git branch:` line above the `Working directory:` line in the prompt. */
export function injectGitBranch(prompt: string, branch: string, cwd: string): string {
    const anchor = `Working directory: ${cwd}`;
    const idx = prompt.indexOf(anchor);
    if (idx === -1) return `${prompt}\nGit branch: ${branch}`;
    return `${prompt.slice(0, idx)}Git branch: ${branch}\n${prompt.slice(idx)}`;
}

export const gitBranchExtension: ExtensionFactory = (pi) => {
    let branch: string | undefined; // undefined = not yet computed; "" = not a git repo

    // Reset on session switch so a fresh in-process session recomputes.
    pi.on("session_start", () => {
        branch = undefined;
    });

    pi.on("before_agent_start", (event) => {
        const cwd = event.systemPromptOptions?.cwd ?? "";
        // Look up the branch once per session, not at boot and not per turn.
        if (branch === undefined) {
            branch = runGit("rev-parse --abbrev-ref HEAD", cwd) ?? "";
        }
        if (!branch) return;
        return { systemPrompt: injectGitBranch(event.systemPrompt, branch, cwd) };
    });
};