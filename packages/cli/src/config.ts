/**
 * PizzaPi CLI configuration — barrel re-export.
 *
 * This file re-exports everything from the focused sub-modules so that all
 * existing callers can continue to import from `./config.js` unchanged.
 *
 * Sub-modules:
 *   config-types.ts   — Interfaces, types, and SANDBOX_MODE_ALIASES
 *   system-prompt.ts  — BUILTIN_SYSTEM_PROMPT constant
 *   sandbox.ts        — Sandbox preset resolution and merge logic
 *   config-io.ts      — Config load/save, hooks, plugin trust, MCP helpers
 */
export * from "./config-types.js";
export * from "./system-prompt.js";
export * from "./sandbox.js";
export * from "./config-io.js";
