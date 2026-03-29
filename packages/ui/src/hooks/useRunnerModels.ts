import { useState, useEffect } from "react";

export interface RunnerModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/**
 * Fetches available models for a runner via REST API.
 * Returns { models, loading }.
 */
export function useRunnerModels(runnerId: string | null | undefined, enabled = true) {
  const [models, setModels] = useState<RunnerModel[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runnerId || !enabled) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModels([]); // Clear stale models from previous runner
    setLoading(true);
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((body: any) => {
        if (!cancelled) {
          setModels(Array.isArray(body?.models) ? body.models : []);
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runnerId, enabled]);

  return { models, loading };
}
