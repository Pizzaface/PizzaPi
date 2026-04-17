import { basename } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Build the PizzaPi terminal title string.
 *
 * Format: `🍕 PizzaPi — <sessionName> — <cwdBasename>`
 * When no session name:  `🍕 PizzaPi — <cwdBasename>`
 */
export function buildPizzapiTitle(sessionName: string | undefined, cwd: string): string {
    const cwdBasename = basename(cwd);
    if (sessionName) {
        return `🍕 PizzaPi — ${sessionName} — ${cwdBasename}`;
    }
    return `🍕 PizzaPi — ${cwdBasename}`;
}

/**
 * PizzaPi terminal title extension.
 *
 * Overrides pi's default terminal title (`π - sessionName - cwd`) with
 * PizzaPi branding.  Updates the title:
 *  - On session start (initial title, name not yet known)
 *  - On session switch (handles resumed sessions that already have a name)
 *  - When the set_session_name tool fires (model has just named the session)
 */
export const pizzapiTitleExtension: ExtensionFactory = (pi) => {
    function updateTitle(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        const title = buildPizzapiTitle(pi.getSessionName(), ctx.cwd);
        ctx.ui.setTitle(title);
    }

    pi.on("session_start", (_event, ctx) => {
        updateTitle(ctx);
    });

    pi.on("session_start", (_event, ctx) => {
        updateTitle(ctx);
    });

    // React to the model calling set_session_name so the title updates immediately
    // after the session is named without waiting for the next event.
    pi.on("tool_execution_end", (event, ctx) => {
        if (event.toolName === "set_session_name") {
            updateTitle(ctx);
        }
    });
};
