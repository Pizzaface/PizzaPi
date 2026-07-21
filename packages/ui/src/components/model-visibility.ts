const storageKey = (runnerId?: string | null) => `pp-hidden-models:${runnerId ?? "unknown"}`;

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export interface RunnerModelVisibility {
  hiddenModels: Set<string>;
  models: ModelInfo[];
}

export function loadHiddenModels(runnerId?: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(runnerId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x: unknown): x is string => typeof x === "string"));
  } catch {}
  return new Set();
}

export function saveHiddenModels(runnerId: string, hidden: Set<string>): void {
  const arr = [...hidden];
  try { localStorage.setItem(storageKey(runnerId), JSON.stringify(arr)); } catch {}
  void fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hiddenModels: arr }),
  }).catch(() => {});
}

export async function fetchRunnerModelVisibility(runnerId: string): Promise<RunnerModelVisibility> {
  try {
    const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      const hiddenModels = new Set<string>(Array.isArray(data?.hiddenModels)
        ? (data.hiddenModels as unknown[]).filter((x): x is string => typeof x === "string")
        : []);
      const catalog = Array.isArray(data?.allModels) ? data.allModels : data?.models;
      const models = Array.isArray(catalog)
        ? (catalog as unknown[]).filter((model): model is ModelInfo => {
            if (!model || typeof model !== "object") return false;
            const item = model as Record<string, unknown>;
            return typeof item.provider === "string" && typeof item.id === "string";
          })
        : [];
      try { localStorage.setItem(storageKey(runnerId), JSON.stringify([...hiddenModels])); } catch {}
      return { hiddenModels, models };
    }
  } catch {}
  return { hiddenModels: loadHiddenModels(runnerId), models: [] };
}
