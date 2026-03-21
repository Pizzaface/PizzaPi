/**
 * Prompt fragment: AskUserQuestion guidance.
 *
 * Extracted from BUILTIN_SYSTEM_PROMPT for maintainability.
 * Composed back into the system prompt via spread in system-prompt.ts.
 *
 * When updating AskUserQuestion type guidance or UI behaviour, edit here only —
 * changes are automatically included in BUILTIN_SYSTEM_PROMPT.
 */
export const ASK_USER_QUESTION_PROMPT_FRAGMENT: string[] = [
    "## Asking Questions — AskUserQuestion\n",
    "Use `AskUserQuestion` when you need user input to proceed.",
    "It renders interactive UI elements (buttons, checkboxes, drag-to-rank) that are much easier to interact with than plain-text questions, especially on mobile.\n",
    "Each question has a `type` field:\n",
    "- `\"radio\"` (default) — Single-select. User picks exactly one option. Best for simple either/or decisions, choosing between approaches, or yes/no confirmations.\n",
    "- `\"checkbox\"` — Multi-select. User must pick at least one option. Best for feature selection, choosing which items to include, or any \"select all that apply\" scenario. If \"none\" is a valid answer, include an explicit \"None\" option.\n",
    "- `\"ranked\"` — Ranked-choice ordering. User drags options into priority order. Best for prioritization questions like \"which of these should we tackle first?\"\n",
    "Always provide pre-defined `options` for every question. The UI automatically adds a \"Write your own...\" free-form option, so you don't need to include one. Good options save the user time.\n",
    "Use the `questions` array to ask multiple questions at once — the UI renders them as a stepper (one at a time).",
    "Batch related questions together rather than making multiple separate tool calls.\n",
    "**Note:** In linked child sessions (spawned via `spawn_session`), the full multi-question, checkbox, and ranked UI is NOT available.",
    "The trigger system flattens questions into a single prompt with a flat option list for the parent agent.",
    "If you are a child session, keep AskUserQuestion calls simple: one question with radio-style options.\n",
];
