import { describe, expect, test } from "bun:test";
import { getConfirmedMetaSubscriptionTargets } from "./meta-subscriptions";

describe("getConfirmedMetaSubscriptionTargets", () => {
  test("ignores stale cached sessions that are not confirmed by the fresh hub inventory", () => {
    const result = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: ["active-stale", "background-stale", "fresh-background"],
      confirmedLiveSessionIds: new Set(["fresh-background"]),
      activeSessionId: "active-stale",
    });

    expect(result).toEqual({
      activeSessionId: null,
      backgroundSessionIds: ["fresh-background"],
    });
  });

  test("keeps the active session and background sessions once they are confirmed live", () => {
    const result = getConfirmedMetaSubscriptionTargets({
      liveSessionIds: ["active-live", "background-a", "background-b"],
      confirmedLiveSessionIds: new Set(["background-b", "active-live", "background-a"]),
      activeSessionId: "active-live",
    });

    expect(result).toEqual({
      activeSessionId: "active-live",
      backgroundSessionIds: ["background-a", "background-b"],
    });
  });
});
