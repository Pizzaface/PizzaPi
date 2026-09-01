import { execSync } from "node:child_process";
import { renderSystemPrompt } from "./system-prompt.precompiled.js";
import type { SystemPromptContext } from "./system-prompt.precompiled.js";

export type { SystemPromptContext };

/** Run a git command and return trimmed stdout, or undefined on failure. */
export function runGit(args: string, cwd?: string): string | undefined {
    try {
        return execSync(`git ${args}`, {
            cwd,
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Gather git context for the current working directory.
 * Returns only the fields that are available (non-undefined).
 *
 * No git branch here — it's injected per-session by the git-branch
 * extension (extensions/git-branch.ts). Baking it at boot goes stale the
 * moment anything checks out another branch.
 */
function gatherGitContext(cwd?: string): Pick<SystemPromptContext, "gitWorktree"> {
    // Detect worktree: if the git dir is a file (not a directory), we're in a linked worktree.
    // Also check `git rev-parse --show-toplevel` vs `git rev-parse --git-common-dir`.
    const commonDir = runGit("rev-parse --git-common-dir", cwd);
    const gitDir = runGit("rev-parse --git-dir", cwd);
    // In a worktree, gitDir points to .git/worktrees/<name>, commonDir points to main .git
    const isWorktree = commonDir && gitDir && commonDir !== gitDir && !gitDir.endsWith("/.git");
    const gitWorktree = isWorktree ? runGit("rev-parse --show-toplevel", cwd) : undefined;

    return { gitWorktree };
}

/**
 * Build the built-in system prompt with dynamic context values.
 *
 * Template source: src/config/templates/system-prompt.hbs
 * Precompiled at build time by: scripts/compile-prompt.ts
 */
export function buildSystemPrompt(ctx?: Partial<SystemPromptContext>): string {
    const gitCtx = gatherGitContext(ctx?.cwd);

    return renderSystemPrompt({
        dateTime: ctx?.dateTime ?? new Date().toLocaleString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
        }),
        gitWorktree: ctx?.gitWorktree ?? gitCtx.gitWorktree,
        cwd: ctx?.cwd,
        isRunner: ctx?.isRunner,
    });
}

/**
 * Build the built-in system prompt unless the user disabled it via
 * `builtinSystemPrompt: false` in ~/.pizzapi/config.json.
 */
export function maybeBuildSystemPrompt(
    config: { builtinSystemPrompt?: boolean },
    ctx?: Partial<SystemPromptContext>,
): string | undefined {
    return config.builtinSystemPrompt === false ? undefined : buildSystemPrompt(ctx);
}

/**
 * @deprecated Use `buildSystemPrompt()` for dynamic context support.
 * Kept for backward compatibility — evaluates with current date/time.
 */
export const BUILTIN_SYSTEM_PROMPT = buildSystemPrompt();
