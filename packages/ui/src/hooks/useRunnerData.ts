import * as React from "react";
import type { RunnerInfo } from "@pizzapi/protocol";

export function findRunnerById(runners: RunnerInfo[], runnerId: string | null | undefined): RunnerInfo | null {
    if (!runnerId) return null;
    return runners.find((runner) => runner.runnerId === runnerId) ?? null;
}

export function useRunnerData(runners: RunnerInfo[], runnerId: string | null | undefined): RunnerInfo | null {
    return React.useMemo(() => findRunnerById(runners, runnerId), [runners, runnerId]);
}
