import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/**
 * Restart extension — adds a /restart command that reloads the extension
 * runtime in place, picking up any source changes made during development.
 */
export const restartExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("restart", {
        description: "Reload the extension runtime to pick up source changes (dev reload)",
        handler: async (_args, ctx) => {
            await ctx.reload();
        },
    });
};
