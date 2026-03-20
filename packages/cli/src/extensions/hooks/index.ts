export type { HookResult, HookOutput } from "./types.js";
export { matchesTool, normalizeToolInput } from "./matcher.js";
export { resolveShell, _resetShellCache, runHook, parseHookOutput } from "./runner.js";
export { getMatchingHooks, runEventHooks, runFireAndForgetHooks } from "./events.js";
export { createHooksExtension } from "./extension.js";
