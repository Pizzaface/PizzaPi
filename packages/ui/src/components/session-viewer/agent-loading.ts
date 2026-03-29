import * as React from "react";

export interface AgentEntry {
  name: string;
  description?: string;
  content?: string;
}

export interface AgentLoadingDeps {
  sessionId: string | null;
  runnerId?: string;
  runnerInfo?: import("@pizzapi/protocol").RunnerInfo | null;
  commandOpen: boolean;
  isAgentMode: boolean;
  agentQuery: string;
}

export interface AgentLoadingResult {
  agentsList: AgentEntry[];
  agentsLoading: boolean;
  agentCandidates: AgentEntry[];
}

/**
 * Manages the agent list used by the "/agents" command picker.
 *
 * Strategy:
 * 1. Pre-populate from cached `runnerInfo.agents` immediately (no flicker).
 * 2. Fetch full agent data (including `content`) in background via REST.
 * 3. Reset the request guard when agent-mode closes, so re-entry triggers a fresh fetch.
 */
export function useAgentLoading({
  sessionId,
  runnerId,
  runnerInfo,
  commandOpen,
  isAgentMode,
  agentQuery,
}: AgentLoadingDeps): AgentLoadingResult {
  const [agentsList, setAgentsList] = React.useState<AgentEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = React.useState(false);
  const agentsRequestedRef = React.useRef<string | null>(null);

  // Pre-populate from cache, then fetch full data in background
  React.useEffect(() => {
    if (!sessionId || !commandOpen || !isAgentMode || !runnerId) return;
    const requestKey = `${sessionId}-${runnerId}`;
    if (agentsRequestedRef.current === requestKey) return;
    agentsRequestedRef.current = requestKey;
    let stale = false;

    // Immediately show cached agent names to prevent loading flicker
    const cachedAgents = (runnerInfo?.agents ?? []).map((a) => ({
      name: a.name,
      description: a.description,
    }));
    setAgentsList(cachedAgents);

    // Fetch full agent data in background (REST list doesn't include content,
    // but this keeps the list current and enables content-based spawning)
    setAgentsLoading(true);
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => {
        if (stale) return;
        const raw = data as { agents?: AgentEntry[] };
        const agents = Array.isArray(raw?.agents) ? raw.agents : [];
        setAgentsList(agents);
      })
      .catch(() => {
        /* keep cached data on error */
      })
      .finally(() => {
        if (!stale) setAgentsLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [sessionId, commandOpen, isAgentMode, runnerId, runnerInfo]);

  // Reset request guard when agent mode closes so re-entry triggers a fresh fetch
  React.useEffect(() => {
    if (!commandOpen || !isAgentMode) {
      agentsRequestedRef.current = null;
    }
  }, [commandOpen, isAgentMode]);

  const agentCandidates = React.useMemo(() => {
    if (!agentQuery) return agentsList;
    return agentsList.filter((a) => {
      const name = a.name.toLowerCase();
      const desc = (a.description ?? "").toLowerCase();
      return name.includes(agentQuery) || desc.includes(agentQuery);
    });
  }, [agentsList, agentQuery]);

  return { agentsList, agentsLoading, agentCandidates };
}
