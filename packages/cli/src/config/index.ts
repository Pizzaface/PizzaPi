/**
 * PizzaPi CLI configuration — module barrel.
 *
 * Sub-modules:
 *   types.ts         — Interfaces, types, and SANDBOX_MODE_ALIASES
 *   system-prompt.ts — BUILTIN_SYSTEM_PROMPT constant
 *   sandbox.ts       — Sandbox preset resolution and merge logic
 *   io.ts            — Config load/save, hooks, plugin trust, MCP helpers
 */
export * from "./types.js";
export * from "./system-prompt.js";
export * from "./sandbox.js";
export * from "./io.js";
