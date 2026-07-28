import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildPromptTemplatePaths, buildSkillPaths } from "../skills.js";
import { getPluginSkillPaths } from "./claude-plugins.js";

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
 */
export function createResourcePathsExtension(options: {
    configSkills?: string[];
    skipPlugins?: boolean;
} = {}): ExtensionFactory {
    return (pi) => {
        pi.on("resources_discover", (event: { cwd: string }) => {
            const cwd = event.cwd;
            return {
                skillPaths: [
                    ...buildSkillPaths(cwd, options.configSkills),
                    ...(options.skipPlugins ? [] : getPluginSkillPaths(cwd)),
                ],
                promptPaths: buildPromptTemplatePaths(cwd),
            };
        });
    };
}
