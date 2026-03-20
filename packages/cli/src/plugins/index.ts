/**
 * Barrel re-export for the Claude Code plugin adapter.
 *
 * Modules:
 *   types.ts     Constants, utilities, and all TypeScript interfaces
 *   parse.ts     Frontmatter, manifest, command, hook, skill, agent, rule parsers
 *   discover.ts  Directory discovery and Claude Code marketplace integration
 *   hooks.ts     Hook event mapping (Claude → pi) and tool matcher logic
 *   info.ts      Lightweight PluginInfo serialization for the Web UI / API
 */
export * from "./types.js";
export * from "./parse.js";
export * from "./discover.js";
export * from "./hooks.js";
export * from "./info.js";
