import type { AgentEntry } from "./agent-loading";

const agentsCache = new Map<string, AgentEntry[]>();
const agentsPending = new Map<string, Promise<AgentEntry[]>>();

export function loadAgents(runnerId: string): Promise<AgentEntry[]> {
  const cached = agentsCache.get(runnerId);
  if (cached) return Promise.resolve(cached);

  const pending = agentsPending.get(runnerId);
  if (pending) return pending;

  const request = fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((data: unknown) => {
      const raw = data as { agents?: AgentEntry[] };
      const agents = Array.isArray(raw?.agents) ? raw.agents : [];
      agentsCache.set(runnerId, agents);
      return agents;
    })
    .finally(() => {
      agentsPending.delete(runnerId);
    });

  agentsPending.set(runnerId, request);
  return request;
}
