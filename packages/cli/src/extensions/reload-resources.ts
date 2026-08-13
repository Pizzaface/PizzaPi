/**
 * `/skills reload` — re-read skills from disk without restarting the session.
 *
 * pi's `ctx.reload()` re-reads extensions, skills, prompt templates, themes and
 * context files, so a newly written skill becomes usable immediately. The web
 * UI's Reload button reaches this by delivering the slash command as session
 * input (see POST /api/runners/:id/skills/reload) — `reload` only exists on a
 * command context, and pi invalidates that context once reload completes, so
 * there is nothing safe to cache for out-of-band callers.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("reload");

export const reloadResourcesExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("skills", {
        description: "Reload skills (and other resources) from disk without restarting the session",
        getArgumentCompletions: (prefix: string) => {
            const options = [{ value: "reload", label: "reload", description: "Re-scan skill directories" }];
            const p = prefix.trim().toLowerCase();
            const filtered = p ? options.filter((o) => o.value.startsWith(p)) : options;
            return filtered.length ? filtered : null;
        },
        handler: async (args: string, ctx: any) => {
            const sub = (args ?? "").trim().split(/\s+/)[0] || "reload";
            if (sub !== "reload") {
                ctx?.ui?.notify?.("Usage: /skills reload");
                return;
            }
            // Notify first: reload() invalidates this ctx, so afterwards there
            // is no ui handle left to report success through.
            ctx?.ui?.notify?.("Reloading skills…");
            try {
                await ctx.reload();
                log.info("skills reloaded");
            } catch (err) {
                log.error("skills reload failed:", err);
                ctx?.ui?.notify?.(`Skills reload failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    });
};
