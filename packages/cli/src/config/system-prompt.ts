import { renderSystemPrompt } from "./system-prompt.precompiled.js";
import type { SystemPromptContext } from "./system-prompt.precompiled.js";

export type { SystemPromptContext };

/**
 * Build the built-in system prompt with dynamic context values.
 *
 * Template source: src/config/templates/system-prompt.hbs
 * Precompiled at build time by: scripts/compile-prompt.ts
 */
export function buildSystemPrompt(ctx?: Partial<SystemPromptContext>): string {
    return renderSystemPrompt({
        todaysDate: ctx?.todaysDate ?? new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
        }),
    });
}

/**
 * @deprecated Use `buildSystemPrompt()` for dynamic context support.
 * Kept for backward compatibility — evaluates with current date.
 */
export const BUILTIN_SYSTEM_PROMPT = buildSystemPrompt();
