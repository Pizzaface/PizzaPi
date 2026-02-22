import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

export interface TodoItem {
    id: number;
    text: string;
    status: "pending" | "in_progress" | "done" | "cancelled";
}

// Module-level state so remote.ts can read it without import cycles.
let currentTodoList: TodoItem[] = [];

/** Returns the current todo list (used by the remote extension for heartbeats). */
export function getCurrentTodoList(): TodoItem[] {
    return currentTodoList;
}

/** Called by the remote extension to get notified when the list changes. */
let _onTodoUpdate: ((list: TodoItem[]) => void) | null = null;

export function setTodoUpdateCallback(cb: (list: TodoItem[]) => void): void {
    _onTodoUpdate = cb;
}

function normalizeTodos(raw: unknown): TodoItem[] {
    if (!Array.isArray(raw)) return [];
    const VALID_STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);
    return raw
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
        .map((item, idx) => ({
            id: typeof item.id === "number" ? item.id : idx + 1,
            text: typeof item.text === "string" ? item.text.trim() : String(item.text ?? "").trim(),
            status: VALID_STATUSES.has(item.status as string)
                ? (item.status as TodoItem["status"])
                : "pending",
        }))
        .filter((item) => item.text.length > 0);
}

/**
 * UpdateTodo extension — provides an invisible `update_todo` tool so the model
 * can maintain a running todo list that is surfaced in the web UI.
 */
export const updateTodoExtension: ExtensionFactory = (pi) => {
    pi.registerTool({
        name: "update_todo",
        label: "Update Todo List",
        description:
            "Update the todo list to reflect the current plan. Call this at the start of your response when you have tasks to track, and update item statuses (pending → in_progress → done) as work progresses. Each call replaces the full list.",
        parameters: {
            type: "object",
            properties: {
                todos: {
                    type: "array",
                    description: "The complete, up-to-date todo list.",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number",
                                description: "Stable numeric ID for this item (reuse across updates).",
                            },
                            text: {
                                type: "string",
                                description: "Short description of the task.",
                            },
                            status: {
                                type: "string",
                                enum: ["pending", "in_progress", "done", "cancelled"],
                                description: "Current status of the task.",
                            },
                        },
                        required: ["id", "text", "status"],
                    },
                },
            },
            required: ["todos"],
        } as any,
        execute: async (_toolCallId, params) => {
            const normalized = normalizeTodos((params as any)?.todos);
            currentTodoList = normalized;
            _onTodoUpdate?.(normalized);
            return {
                content: [{ type: "text" as const, text: "" }],
                details: undefined,
            };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // Inject the instruction into the system prompt on every turn where there are
    // tasks worth tracking (we keep the reminder persistent, not just on first turn,
    // because the model needs to update statuses throughout a long session).
    pi.on("before_agent_start", (event) => {
        return {
            systemPrompt:
                event.systemPrompt +
                "\n\nUse the `update_todo` tool to maintain a running todo list whenever you have multiple tasks to complete. Call it at the start of responses where you have a clear plan, and update item statuses (pending → in_progress → done) as tasks progress. Each call fully replaces the list.",
        };
    });

    // Reset on new session
    pi.on("session_start", () => {
        currentTodoList = [];
        _onTodoUpdate?.([]);
    });

    pi.on("session_switch", () => {
        currentTodoList = [];
        _onTodoUpdate?.([]);
    });
};
