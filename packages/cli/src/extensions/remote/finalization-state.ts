export type SessionFinalizationStatus =
  | "closing"
  | "finalizing"
  | "detached_finalization"
  | "ended";

export interface SessionFinalizationEntry {
  serviceId: string;
  sessionId: string;
  jobId?: string;
  label: string;
  status: SessionFinalizationStatus;
  updatedAt: number;
}

export function applyFinalizationEvent(
  current: SessionFinalizationEntry | null,
  event: {
    type: SessionFinalizationStatus;
    serviceId: string;
    sessionId: string;
    jobId?: string;
    label?: string;
    updatedAt?: number;
  },
): SessionFinalizationEntry | null {
  // Composite key mismatch — event does not belong to this entry.
  if (
    current !== null &&
    (current.serviceId !== event.serviceId || current.sessionId !== event.sessionId)
  ) {
    return current;
  }

  // Starting a new finalization sequence.
  if (current === null) {
    if (event.type !== "closing") {
      return null;
    }
    return {
      serviceId: event.serviceId,
      sessionId: event.sessionId,
      jobId: event.jobId,
      label: event.label ?? "",
      status: "closing",
      updatedAt: event.updatedAt ?? Date.now(),
    };
  }

  // Terminal state — no further transitions.
  if (current.status === "ended") {
    return current;
  }

  const updatedAt = event.updatedAt ?? current.updatedAt;

  switch (current.status) {
    case "closing": {
      if (event.type === "finalizing") {
        return {
          ...current,
          status: "finalizing",
          jobId: event.jobId ?? current.jobId,
          updatedAt,
        };
      }
      if (event.type === "ended") {
        // Service disconnected or cancelled before persisting.
        return null;
      }
      return current;
    }

    case "finalizing": {
      if (event.type === "detached_finalization") {
        return {
          ...current,
          status: "detached_finalization",
          updatedAt,
        };
      }
      if (event.type === "ended") {
        return {
          ...current,
          status: "ended",
          updatedAt,
        };
      }
      return current;
    }

    case "detached_finalization": {
      if (event.type === "ended") {
        return {
          ...current,
          status: "ended",
          updatedAt,
        };
      }
      return current;
    }

    default:
      return current;
  }
}
