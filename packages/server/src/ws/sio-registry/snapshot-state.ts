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
    if (Array.isArray(meta.queuedMessages)) {
        patch.queuedMessages = meta.queuedMessages;
    }
    if (Object.prototype.hasOwnProperty.call(meta, "goal")) {
        patch.goal = meta.goal && typeof meta.goal === "object" ? meta.goal : null;
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

export function shouldPersistSnapshotPatch(input: {
    patch: Record<string, unknown>;
    lastWriteAt: number;
    now: number;
    throttleMs: number;
}): boolean {
    // Throttle applies uniformly — message-bearing patches used to bypass it,
    // but persisting the merged multi-MB state per patch blocks the event loop
    // (bun:sqlite is synchronous). endSharedSession() flushes the final state.
    const { lastWriteAt, now, throttleMs } = input;
    return now - lastWriteAt >= throttleMs;
}

/**
 * Merge a metadata patch into the accumulated snapshot overlay (a small JSON
 * object holding "patches since the last full snapshot"). Never touches the
 * multi-MB lastState blob.
 */
export function mergeSnapshotOverlay(
    existingRaw: string | null | undefined,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    let existing: Record<string, unknown> = {};
    if (existingRaw) {
        try {
            const parsed = JSON.parse(existingRaw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                existing = parsed as Record<string, unknown>;
            }
        } catch {
            // Corrupt overlay — start fresh.
        }
    }

    const merged = { ...existing, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "model")) {
        merged.model = mergeModelPatch(existing.model, patch.model);
    }
    return merged;
}

/**
 * Apply an accumulated snapshot overlay to a session_active-style state object
 * at read time. Returns the original state when the overlay is empty/invalid.
 */
export function applySnapshotOverlayToState(
    state: unknown,
    overlayRaw: string | null | undefined,
): unknown {
    if (!overlayRaw) return state;
    if (!state || typeof state !== "object" || Array.isArray(state)) return state;

    let overlay: unknown;
    try {
        overlay = JSON.parse(overlayRaw);
    } catch {
        return state;
    }
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return state;

    const overlayObj = overlay as Record<string, unknown>;
    if (Object.keys(overlayObj).length === 0) return state;

    const stateObj = state as Record<string, unknown>;
    const merged = { ...stateObj, ...overlayObj };
    if (Object.prototype.hasOwnProperty.call(overlayObj, "model")) {
        merged.model = mergeModelPatch(stateObj.model, overlayObj.model);
    }
    return merged;
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
