/**
 * MCP client layer — barrel re-export.
 *
 * Aggregates all public API from the focused modules in this directory:
 *
 *  types.ts           — shared types, protocol constants, isRecord helper
 *  tool-naming.ts     — collision-safe tool name allocation
 *  transport-stdio.ts — STDIO transport (child-process MCP servers)
 *  transport-http.ts  — HTTP + Streamable HTTP transports (+ OAuth)
 *  registry.ts        — client factory, OAuth lifecycle, tool registration
 */

export * from "./types.js";
export * from "./tool-naming.js";
export * from "./transport-stdio.js";
export * from "./transport-http.js";
export * from "./registry.js";
