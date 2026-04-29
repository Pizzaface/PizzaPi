function normalizeSessionName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function mergeModelPatch(
    existing: unknown,
    next: unknown,
): unknown {
    if (!next || typeof next !== "object" || Array.isArray(next)) return next;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return next;

    const existingModel = existing as Record<string, unknown>;
    const nextModel = next as Record<string, unknown>;
    if (existingModel.provider !== nextModel.provider || existingModel.id !== nextModel.id) {
        return next;
    }

    return {
        ...existingModel,
        ...Object.fromEntries(Object.entries(nextModel).filter(([, value]) => value !== undefined)),
    };
}

export function buildSnapshotPatchFromMetadata(meta: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(meta, "model")) {
        patch.model = meta.model && typeof meta.model === "object" ? meta.model : null;
    }
    if (Object.prototype.hasOwnProperty.call(meta, "sessionName")) {
        patch.sessionName = normalizeSessionName(meta.sessionName);
    }
    if (Object.prototype.hasOwnProperty.call(meta, "thinkingLevel")) {
        patch.thinkingLevel = typeof meta.thinkingLevel === "string" ? meta.thinkingLevel : null;
    }
    if (Array.isArray(meta.availableModels)) {
        patch.availableModels = meta.availableModels;
    }
    if (Array.isArray(meta.availableCommands)) {
        patch.availableCommands = meta.availableCommands;
    }
    if (Array.isArray(meta.todoList)) {
        patch.todoList = meta.todoList;
    }

    return patch;
}

export function buildSnapshotPatchFromCapabilities(event: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (Array.isArray(event.models)) {
        patch.availableModels = event.models;
    }
    if (Array.isArray(event.commands)) {
        patch.availableCommands = event.commands;
    }
    return patch;
}

export function mergeSnapshotStatePatch(
    rawLastState: string | null | undefined,
    patch: Record<string, unknown>,
): Record<string, unknown> | null {
    if (!rawLastState) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawLastState);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }

    const merged = { ...(parsed as Record<string, unknown>), ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "model")) {
        merged.model = mergeModelPatch((parsed as Record<string, unknown>).model, patch.model);
    }

    return merged;
}
