import type { ServiceAnnounceData } from "@pizzapi/protocol";

export type RunnerRefServiceAnnounce = ServiceAnnounceData & {
    runnerId: string;
    _runnerRef: true;
};

export function withRunnerRefHint(runnerId: string, data: ServiceAnnounceData): RunnerRefServiceAnnounce {
    return {
        ...data,
        runnerId,
        _runnerRef: true,
    };
}

export function isRunnerRefServiceAnnounce(value: unknown): value is RunnerRefServiceAnnounce {
    if (!value || typeof value !== "object") return false;
    const data = value as Record<string, unknown>;
    return (
        typeof data.runnerId === "string" &&
        data.runnerId.length > 0 &&
        data._runnerRef === true &&
        Array.isArray(data.serviceIds)
    );
}
