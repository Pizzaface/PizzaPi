/**
 * Command introspection bridge — exposes the extension runner's fully
 * resolved commands (including `getArgumentCompletions` and `argumentHint`)
 * to the remote extension, which only sees pi's `getCommands()` (names and
 * descriptions, no completions).
 *
 * The worker registers a provider after creating the session; the relay
 * context factory reads snapshots when building capabilities for the web UI.
 * When no provider is set (e.g. TUI mode), callers gracefully get no extras.
 */

export interface CommandCompletionItem {
    value: string;
    label?: string;
    description?: string;
}

export interface CommandIntrospection {
    argumentHint?: string;
    completions?: CommandCompletionItem[];
}

interface RegisteredCommandLike {
    name: string;
    invocationName?: string;
    argumentHint?: string;
    getArgumentCompletions?: (prefix: string) => unknown;
}

let provider: (() => RegisteredCommandLike[]) | null = null;

// Async completion results land here for the NEXT capabilities push.
const completionsCache = new Map<string, CommandCompletionItem[]>();

export function setRegisteredCommandsProvider(fn: () => RegisteredCommandLike[]): void {
    provider = fn;
}

/** Snapshot argumentHint + argument completions for every registered command. */
export function getCommandIntrospection(): Map<string, CommandIntrospection> {
    const out = new Map<string, CommandIntrospection>();
    if (!provider) return out;

    let commands: RegisteredCommandLike[];
    try {
        commands = provider() ?? [];
    } catch {
        return out;
    }

    for (const cmd of commands) {
        const name = cmd.invocationName ?? cmd.name;
        if (!name) continue;
        const completions = snapshotCompletions(name, cmd);
        const argumentHint = typeof cmd.argumentHint === "string" ? cmd.argumentHint : undefined;
        if (completions?.length || argumentHint) {
            out.set(name, { argumentHint, completions });
        }
    }
    return out;
}

function snapshotCompletions(
    name: string,
    cmd: RegisteredCommandLike,
): CommandCompletionItem[] | undefined {
    if (typeof cmd.getArgumentCompletions !== "function") return undefined;
    try {
        // Empty prefix = "all options" (same call the TUI makes before typing).
        const result = cmd.getArgumentCompletions("");
        if (Array.isArray(result)) {
            const items = normalizeItems(result);
            completionsCache.set(name, items);
            return items;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
            // ponytail: async completions resolve into the cache and show up on
            // the next capabilities push instead of blocking this (sync) one.
            (result as Promise<unknown>)
                .then((items) => {
                    if (Array.isArray(items)) completionsCache.set(name, normalizeItems(items));
                })
                .catch(() => {});
        }
    } catch {
        // Completion providers must never break capability delivery.
    }
    return completionsCache.get(name);
}

function normalizeItems(items: unknown[]): CommandCompletionItem[] {
    return items
        .filter((i): i is Record<string, unknown> =>
            i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).value === "string")
        .slice(0, 50)
        .map((i) => ({
            value: String(i.value),
            label: typeof i.label === "string" ? i.label : undefined,
            description: typeof i.description === "string" ? i.description : undefined,
        }));
}
