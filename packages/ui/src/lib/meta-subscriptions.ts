export interface ConfirmedMetaSubscriptionTargetsInput {
  liveSessionIds: string[];
  confirmedLiveSessionIds: ReadonlySet<string>;
  activeSessionId: string | null;
}

export interface ConfirmedMetaSubscriptionTargets {
  activeSessionId: string | null;
  backgroundSessionIds: string[];
}

export function getConfirmedMetaSubscriptionTargets(
  input: ConfirmedMetaSubscriptionTargetsInput,
): ConfirmedMetaSubscriptionTargets {
  const activeSessionId =
    input.activeSessionId && input.confirmedLiveSessionIds.has(input.activeSessionId)
      ? input.activeSessionId
      : null;

  const backgroundSessionIds = input.liveSessionIds.filter(
    (sessionId) =>
      sessionId !== activeSessionId && input.confirmedLiveSessionIds.has(sessionId),
  );

  return { activeSessionId, backgroundSessionIds };
}
