export interface DelinkChildrenAckPlan {
    ignoreAck: boolean;
    clearRetryTimer: boolean;
    clearPendingDelink: boolean;
    scheduleRetry: boolean;
}

export function evaluateDelinkChildrenAck(opts: {
    ackEpoch: number;
    pendingEpoch: number | null;
    retryEpoch: number | null;
    ok: boolean | undefined;
    connected: boolean;
}): DelinkChildrenAckPlan {
    if (opts.pendingEpoch !== opts.ackEpoch) {
        return {
            ignoreAck: true,
            clearRetryTimer: opts.retryEpoch === opts.ackEpoch,
            clearPendingDelink: false,
            scheduleRetry: false,
        };
    }

    if (opts.ok === false) {
        return {
            ignoreAck: false,
            clearRetryTimer: opts.retryEpoch === opts.ackEpoch,
            clearPendingDelink: false,
            scheduleRetry: opts.connected,
        };
    }

    return {
        ignoreAck: false,
        clearRetryTimer: opts.retryEpoch === opts.ackEpoch,
        clearPendingDelink: true,
        scheduleRetry: false,
    };
}

export interface DelinkOwnParentAckPlan {
    confirmed: boolean;
    scheduleRetry: boolean;
}

export function evaluateDelinkOwnParentAck(opts: {
    ok: boolean | undefined;
    pending: boolean;
    connected: boolean;
}): DelinkOwnParentAckPlan {
    return {
        confirmed: opts.ok === true,
        scheduleRetry: opts.ok === false && opts.pending && opts.connected,
    };
}
