import * as React from "react";
import { loadHiddenModels, fetchHiddenModels } from "@/components/HiddenModelsManager";

/**
 * Hidden-model set for the model selector. localStorage is the fast-load
 * cache; once authenticated the server copy (source of truth) replaces it.
 */
export function useHiddenModels(session: unknown) {
  const [hiddenModels, setHiddenModels] = React.useState<Set<string>>(() => loadHiddenModels());

  // Fetch hidden models from server once authenticated — server is the
  // source of truth; localStorage is the fast-load cache.
  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetchHiddenModels().then((serverSet) => {
      if (cancelled) return;
      setHiddenModels(serverSet);
    });
    return () => { cancelled = true; };
  }, [session]);

  return { hiddenModels, setHiddenModels };
}
