import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/** Restart-in-place: the runner daemon respawns exit-43 workers under the same session ID. */
function restartWorker(): void {
    process.send?.({ type: "pre_restart" });
    setTimeout(() => process.exit(43), 100);
}

/**
 * Runner workers have no TUI to run pi's `/trust`, so an untrusted project's
 * skills/commands/agents are silently dropped. Ask the web viewer instead,
 * reusing the plugin-trust prompt channel (`plugin:trust_prompt`, kind
 * "project"). Trust persists to trust.json and restarts the worker so the
 * project resources load; Skip is session-only (no persisted "false").
 *
 * ponytail: shares the single pendingPluginTrust slot — an untrusted Claude
 * plugin prompt in the same session displaces this one (shown again next
 * session). Add a prompt queue to the remote bridge if that bites.
 */
export function createProjectTrustPromptExtension(
    cwd: string,
    agentDir: string,
    restart: () => void = restartWorker,
): ExtensionFactory | null {
    // Runner workers only — restart-in-place needs the daemon.
    if (!process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH) return null;
    if (resolve(cwd) === resolve(homedir())) return null; // home = user scope, not a project
    if (!hasTrustRequiringProjectResources(cwd)) return null;

    return (pi) => {
        let prompted = false;
        pi.on("session_start", () => {
            // No ctx.hasUI guard: runner workers bind a web-approval uiContext, so
            // hasUI is true there too. The env gate above already limits this to workers.
            if (prompted) return;
            const store = new ProjectTrustStore(agentDir);
            if (store.get(cwd) !== null) return; // explicit decision already saved
            prompted = true;
            pi.events.emit("plugin:trust_prompt", {
                promptId: randomUUID(),
                kind: "project",
                pluginNames: [cwd],
                pluginSummaries: [cwd],
                respond: (trusted: boolean) => {
                    if (!trusted) return;
                    store.set(cwd, true);
                    restart();
                },
            });
        });
    };
}
