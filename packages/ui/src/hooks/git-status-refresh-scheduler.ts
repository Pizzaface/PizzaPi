export interface PostMutationRefreshScheduler {
    schedule: () => void;
    cancel: () => void;
    dispose: () => void;
}

interface CreatePostMutationRefreshSchedulerOptions {
    debounceMs: number;
    getGeneration: () => number;
    isStatusRequestInFlight: () => boolean;
    triggerRefresh: () => void;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timerId: ReturnType<typeof setTimeout>) => void;
}

export function createPostMutationRefreshScheduler({
    debounceMs,
    getGeneration,
    isStatusRequestInFlight,
    triggerRefresh,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}: CreatePostMutationRefreshSchedulerOptions): PostMutationRefreshScheduler {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const cancel = () => {
        if (!timerId) return;
        clearTimer(timerId);
        timerId = null;
    };

    const schedule = () => {
        if (disposed) return;
        if (isStatusRequestInFlight()) return;

        const generationAtSchedule = getGeneration();
        cancel();

        timerId = setTimer(() => {
            timerId = null;
            if (disposed) return;
            if (getGeneration() !== generationAtSchedule) return;
            if (isStatusRequestInFlight()) return;
            triggerRefresh();
        }, debounceMs);
    };

    const dispose = () => {
        disposed = true;
        cancel();
    };

    return { schedule, cancel, dispose };
}
