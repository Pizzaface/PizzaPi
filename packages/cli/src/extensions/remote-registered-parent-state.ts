export type RegisteredParentStateDecision =
    | { kind: "link"; parentSessionId: string }
    | { kind: "ignore_stale_server_link" }
    | { kind: "explicit_delink" }
    | { kind: "transient_offline" }
    | { kind: "no_change" };

/**
 * Classify how the client should update its local parent-link state after a
 * `registered` payload arrives from the relay.
 *
 * The key distinction is between:
 * - explicit delink (`wasDelinked: true`) → clear child state permanently
 * - transient parent outage (`parentSessionId: null`, no `wasDelinked`) → keep
 *   child mode active so parent-routed flows recover if the parent reconnects
 */
export function decideRegisteredParentState(opts: {
    serverParentSessionId: string | null | undefined;
    localParentSessionId: string | null;
    pendingDelinkOwnParent: boolean;
    wasDelinked?: boolean;
}): RegisteredParentStateDecision {
    const {
        serverParentSessionId,
        localParentSessionId,
        pendingDelinkOwnParent,
        wasDelinked,
    } = opts;

    if (serverParentSessionId && !pendingDelinkOwnParent) {
        return { kind: "link", parentSessionId: serverParentSessionId };
    }

    if (serverParentSessionId && pendingDelinkOwnParent) {
        return { kind: "ignore_stale_server_link" };
    }

    if (localParentSessionId && !serverParentSessionId) {
        return wasDelinked
            ? { kind: "explicit_delink" }
            : { kind: "transient_offline" };
    }

    return { kind: "no_change" };
}
