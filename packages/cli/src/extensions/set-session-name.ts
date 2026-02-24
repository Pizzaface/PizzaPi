import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * Set-session-name extension — provides an invisible tool for the model to
 * name the conversation on the first turn, plus a /name command for manual
 * renaming.
 */
export const setSessionNameExtension: ExtensionFactory = (pi) => {
    let named = false;

    // Reset naming state on each new/switched session so fresh sessions can be named.
    // For resumed sessions pi.getSessionName() will be non-null, so before_agent_start
    // will still skip the naming instruction via its own guard.
    pi.on("session_start", () => {
        named = false;
    });
    pi.on("session_switch", () => {
        named = false;
    });

    // A silent tool the model calls to name the session.
    // renderCall/renderResult return an empty component so nothing is shown in the TUI.
    pi.registerTool({
        name: "set_session_name",
        label: "Set Session Name",
        description:
            "Set the session name. Call this tool at the start of your FIRST response with a 3–6 word summary of the user's request. Do NOT output the session name as plain text.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "A 3–6 word summary of the user's request",
                },
            },
            required: ["name"],
        } as any,
        execute: async (_toolCallId, params) => {
            if (!named && !pi.getSessionName()) {
                pi.setSessionName(params.name.trim());
                named = true;
            }
            return {
                content: [{ type: "text" as const, text: "" }],
                details: undefined,
            };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    pi.on("before_agent_start", (event) => {
        // Only inject naming instruction on the very first turn
        if (named || pi.getSessionName()) return;

        return {
            systemPrompt:
                event.systemPrompt +
                "\n\nAt the start of your FIRST response only, call the `set_session_name` tool with a 3–6 word summary of the user's request. Do not output the session name as text in your response.",
        };
    });
};
