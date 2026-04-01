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
    let hasPendingRefresh = false;

    const runWhenReady = (generationAtSchedule: number) => {
        timerId = null;
        if (disposed) return;
        if (getGeneration() !== generationAtSchedule) {
            hasPendingRefresh = false;
            return;
        }
        if (!hasPendingRefresh) return;

        if (isStatusRequestInFlight()) {
            timerId = setTimer(() => runWhenReady(generationAtSchedule), debounceMs);
            return;
        }

        hasPendingRefresh = false;
        triggerRefresh();
    };

    const cancel = () => {
        hasPendingRefresh = false;
        if (!timerId) return;
        clearTimer(timerId);
        timerId = null;
    };

    const schedule = () => {
        if (disposed) return;
        hasPendingRefresh = true;

        const generationAtSchedule = getGeneration();
        if (timerId) clearTimer(timerId);

        timerId = setTimer(() => runWhenReady(generationAtSchedule), debounceMs);
    };

    const dispose = () => {
        disposed = true;
        cancel();
    };

    return { schedule, cancel, dispose };
}
