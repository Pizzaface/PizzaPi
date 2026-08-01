import { resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildPromptTemplatePaths, buildSkillPaths } from "../skills.js";
import { getPluginSkillPaths, getPluginPromptTemplatePaths } from "./claude-plugins.js";

/**
 * Resource-paths extension — supplies skill and prompt-template paths via
 * pi's `resources_discover` event, mirroring `buildSkillPaths()` +
 * `buildPromptTemplatePaths()` + plugin skill paths.
 *
 * ponytail: this duplicates the `additionalSkillPaths` /
 * `additionalPromptTemplatePaths` constructor options still passed to
 * `DefaultResourceLoader` in worker.ts and index.ts (dual-path, by design —
 * see p23-b). Upstream docs/dist confirm `resources_discover` fires after
 * `session_start` and is awaited (inside `bindExtensions()`) before any
 * prompt is processed in every mode this codebase uses (interactive,
 * headless worker, print/rpc), so the two paths should always agree. Remove
 * the constructor options only once that's been observed safe in practice.
 *
 * `configSkills` should be `config.skills` from the resolved PizzaPi config,
 * and `skipPlugins` should mirror the `--no-plugins` / `skipPlugins` flag
 * used elsewhere so plugin skills aren't double-loaded when plugins are off.
 *
 * `cwd`, when provided, is the cwd already covered by that same
 * `DefaultResourceLoader`'s constructor options. pi's `extendResources()`
 * (called with whatever this handler returns) always tags reported paths
 * with synthetic `{ scope: "temporary", origin: "top-level" }` provenance —
 * and checks that tag *before* the constructor-derived metadata (see
 * resource-loader.js `findSourceInfoForPath`). Re-reporting the same paths
 * we already told the constructor about would silently clobber their real
 * provenance (e.g. `auto`/`user` -> `extension:.../temporary`) for zero net
 * new paths (PR #638 review, P2). So: skip re-reporting when `event.cwd`
 * matches the baseline `cwd` (nothing new to say), but still discover fresh
 * paths when it differs (e.g. a reload into a different directory).
 */
export function createResourcePathsExtension(options: {
    configSkills?: string[];
    skipPlugins?: boolean;
    cwd?: string;
} = {}): ExtensionFactory {
    const baselineCwd = options.cwd ? resolve(options.cwd) : undefined;
    return (pi) => {
        pi.on("resources_discover", (event: { cwd: string }) => {
            if (baselineCwd && resolve(event.cwd) === baselineCwd) {
                return { skillPaths: [], promptPaths: [] };
            }
            const cwd = event.cwd;
            return {
                skillPaths: [
                    ...buildSkillPaths(cwd, options.configSkills),
                    ...(options.skipPlugins ? [] : getPluginSkillPaths(cwd)),
                ],
                promptPaths: [
                    ...buildPromptTemplatePaths(cwd),
                    ...(options.skipPlugins ? [] : getPluginPromptTemplatePaths(cwd)),
                ],
            };
        });
    };
}
