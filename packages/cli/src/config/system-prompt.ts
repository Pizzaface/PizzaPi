import { execSync } from "node:child_process";
import { renderSystemPrompt } from "./system-prompt.precompiled.js";
import type { SystemPromptContext } from "./system-prompt.precompiled.js";

export type { SystemPromptContext };

/** Run a git command and return trimmed stdout, or undefined on failure. */
function git(args: string, cwd?: string): string | undefined {
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
 */
function gatherGitContext(cwd?: string): Pick<SystemPromptContext, "gitBranch" | "gitWorktree"> {
    const gitBranch = git("rev-parse --abbrev-ref HEAD", cwd);

    // Detect worktree: if the git dir is a file (not a directory), we're in a linked worktree.
    // Also check `git rev-parse --show-toplevel` vs `git rev-parse --git-common-dir`.
    const commonDir = git("rev-parse --git-common-dir", cwd);
    const gitDir = git("rev-parse --git-dir", cwd);
    // In a worktree, gitDir points to .git/worktrees/<name>, commonDir points to main .git
    const isWorktree = commonDir && gitDir && commonDir !== gitDir && !gitDir.endsWith("/.git");
    const gitWorktree = isWorktree ? git("rev-parse --show-toplevel", cwd) : undefined;

    return { gitBranch, gitWorktree };
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
        gitBranch: ctx?.gitBranch ?? gitCtx.gitBranch,
        gitWorktree: ctx?.gitWorktree ?? gitCtx.gitWorktree,
        cwd: ctx?.cwd,
        isRunner: ctx?.isRunner,
    });
}

/**
 * Rewrite a system prompt to use "Claude Code" branding instead of "pi" / "PizzaPi".
 *
 * Applies targeted string replacements so the prompt looks like it originates from
 * the official Claude Code CLI. Useful for Anthropic Max subscriptions where the
 * server-side detection pattern-matches system prompt content.
 *
 * Safe to call on both the upstream base prompt (identity line) and the PizzaPi
 * appendSystemPrompt content.
 */
export function rewriteForClaudeCodeProvider(prompt: string): string {
    return prompt
        // Identity line from upstream pi-coding-agent
        .replace(
            /You are an expert coding assistant operating inside pi, a coding agent harness\./g,
            "You are Claude Code, Anthropic's official CLI for Claude.",
        )
        // "PizzaPi" as a product name → "Claude Code"
        .replace(/PizzaPi/g, "Claude Code")
        // Standalone "Pi " at word boundary (e.g. "Pi documentation", "Pi TUI")
        .replace(/\bPi\b(?=\s+(?:documentation|TUI|packages|topics|\.md))/g, "Claude Code")
        // "operating inside pi" (if phrased differently)
        .replace(/\binside pi\b/g, "inside Claude Code")
        // "pi itself" / "pi topics" / "pi, a coding"
        .replace(/\bpi\b(?=\s+(?:itself|topics|packages|coding))/g, "Claude Code")
        // "about pi" at word boundary
        .replace(/\babout pi\b/g, "about Claude Code")
        // "pi but" (as in "built on top of pi but")
        .replace(/\bpi but\b/g, "Claude Code but")
        // Path references: ~/.pizzapi/ → ~/.claude/
        .replace(/~\/\.pizzapi\//g, "~/.claude/")
        // Path references: .pizzapi/ (project-local) → .claude/
        .replace(/(^|[^~\/])\.pizzapi\//gm, "$1.claude/")
        // Config section name
        .replace(/pizzapi-configuration/g, "claude-code-configuration");
}

/**
 * @deprecated Use `buildSystemPrompt()` for dynamic context support.
 * Kept for backward compatibility — evaluates with current date/time.
 */
export const BUILTIN_SYSTEM_PROMPT = buildSystemPrompt();
