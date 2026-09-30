import * as React from "react";
import type { HubSession } from "@/components/SessionSidebar";
import type { BetterAuthSession } from "@/lib/auth-client";
import type { useRunnersFeed } from "@/lib/useRunnersFeed";
import type { SidebarRunner } from "./types";

type FeedRunner = ReturnType<typeof useRunnersFeed>["runners"][number];

/** User-scoped sessionStorage key for sidebar runners (prevents cross-account leakage). */
export function sidebarRunnersCacheKey(userId: string | null | undefined): string | null {
  return userId ? `pp-sidebar-runners:${userId}` : null;
}

/** Map runners-feed entries to sidebar rows, counting each runner's live sessions. */
export function deriveSidebarRunners(feedRunners: FeedRunner[], liveSessions: HubSession[]): SidebarRunner[] {
  return feedRunners.map((r) => ({
    runnerId: r.runnerId,
    name: r.name,
    sessionCount: liveSessions.filter((s) => s.runnerId === r.runnerId).length,
    version: r.version,
    isOnline: true,
  }));
}

/**
 * Sidebar runner list, derived from the /runners WS feed and write-through
 * cached in sessionStorage per user so a reload paints immediately.
 */
export function useSidebarRunners(
  session: unknown,
  feedRunners: FeedRunner[],
  liveSessions: HubSession[],
) {
  const [runnersForSidebar, setRunnersForSidebar] = React.useState<SidebarRunner[]>([]);
  // User-scoped cache key for sidebar runners (prevents cross-account data leakage)
  const sidebarCacheKey = React.useMemo(() => {
    const userId = (session as BetterAuthSession | null)?.user?.id ?? null;
    return sidebarRunnersCacheKey(userId);
  }, [session]);
  // Hydrate from cache once we know the user
  React.useEffect(() => {
    if (!sidebarCacheKey) return;
    try {
      const cached = sessionStorage.getItem(sidebarCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) setRunnersForSidebar(parsed);
      }
    } catch { /* ignore */ }
    // Clean up legacy unscoped key
    try { sessionStorage.removeItem("pp-sidebar-runners"); } catch { /* ignore */ }
  }, [sidebarCacheKey]);
  // Write-through: persist sidebar runners to sessionStorage on every update
  const setSidebarRunners = React.useCallback((runners: SidebarRunner[]) => {
    setRunnersForSidebar(runners);
    if (sidebarCacheKey) {
      try { sessionStorage.setItem(sidebarCacheKey, JSON.stringify(runners)); } catch { /* ignore */ }
    }
  }, [sidebarCacheKey]);

  // Derive sidebar runners from the /runners WS feed
  React.useEffect(() => {
    setSidebarRunners(deriveSidebarRunners(feedRunners, liveSessions));
  }, [feedRunners, liveSessions, setSidebarRunners]);

  return runnersForSidebar;
}
