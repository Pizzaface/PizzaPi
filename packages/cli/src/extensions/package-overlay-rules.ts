/**
 * Mounts `pi.pizzapi.rules` from configured pi packages as additive
 * `before_agent_start` context (docs/specs/pi-pizzapi-overlay.md §4.3, §9.1).
 *
 * Registered in factories.ts BEFORE the legacy Claude-plugin rules adapter
 * (claude-plugins.ts) so package rules land in the system prompt first —
 * "package-before-legacy" ordering. The legacy dir-based plugin `rules/`
 * adapter is retained unchanged during migration.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { collectOverlayRuleBlocks } from "../overlay/session-packages.js";

/**
 * Build the extension factory. Rule discovery runs once at factory-creation
 * time (same convention as claude-plugins.ts) — a malformed overlay never
 * throws (resolveSessionOverlays already isolates and warns), so a broken
 * package can never prevent this factory (or session startup) from loading.
 */
export function createPackageOverlayRulesExtension(cwd: string, agentDir: string): ExtensionFactory | null {
    const blocks = collectOverlayRuleBlocks(cwd, agentDir);
    if (blocks.length === 0) return null;

    const section = `\n\n# Package Rules\n\n${blocks.map((b) => b.text).join("\n\n")}`;

    return (pi) => {
        pi.on("before_agent_start", async (event) => {
            return { systemPrompt: event.systemPrompt + section };
        });
    };
}
