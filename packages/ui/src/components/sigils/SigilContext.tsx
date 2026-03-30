/**
 * SigilContext — provides the SigilRegistry and resolve infrastructure
 * to sigil components.
 *
 * Wrap your message rendering tree in <SigilProvider> and sigil pills
 * will automatically pick up type configs, service definitions, and
 * resolve enriched data from service endpoints.
 */
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { ServiceSigilDef, ServicePanelInfo } from "@pizzapi/protocol";
import { SigilRegistry, createRegistry } from "@/lib/sigils/registry";

// ── Resolve types ────────────────────────────────────────────────────────────

export interface SigilResolveData {
  title?: string;
  status?: string;
  author?: string;
  url?: string;
  description?: string;
  icon?: string;
  [key: string]: unknown;
}

interface SigilResolveState {
  data?: SigilResolveData;
  loading: boolean;
  error?: string;
}

// ── Context ──────────────────────────────────────────────────────────────────

interface SigilContextValue {
  registry: SigilRegistry;
  resolve: (type: string, id: string) => SigilResolveState;
  triggerResolve: (type: string, id: string) => void;
}

const SigilCtx = createContext<SigilContextValue>({
  registry: createRegistry(),
  resolve: () => ({ loading: false }),
  triggerResolve: () => {},
});

export function useSigilRegistry(): SigilRegistry {
  return useContext(SigilCtx).registry;
}

export function useSigilResolve(type: string, id: string) {
  const ctx = useContext(SigilCtx);
  return ctx.resolve(type, id);
}

export function useSigilTriggerResolve() {
  return useContext(SigilCtx).triggerResolve;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface SigilProviderProps {
  sigilDefs: ServiceSigilDef[];
  panels: ServicePanelInfo[];
  runnerId?: string;
  children: React.ReactNode;
}

/**
 * Provider that creates a SigilRegistry from service definitions
 * and manages resolve endpoint calls for enriching sigil display data.
 */
export function SigilProvider({ sigilDefs, panels, runnerId, children }: SigilProviderProps) {
  const registry = useMemo(() => createRegistry(sigilDefs), [sigilDefs]);

  // Resolve cache: keyed by "type:id"
  const cacheRef = useRef(new Map<string, SigilResolveState>());
  // Force re-render tracking
  const subscribersRef = useRef(new Set<() => void>());

  // Build panel port lookup: serviceId → port
  const panelPortMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of panels) map.set(p.serviceId, p.port);
    return map;
  }, [panels]);

  const resolve = useCallback(
    (type: string, id: string): SigilResolveState => {
      const key = `${type}:${id}`;
      return cacheRef.current.get(key) ?? { loading: false };
    },
    [],
  );

  const triggerResolve = useCallback(
    (type: string, id: string) => {
      const key = `${type}:${id}`;
      const cache = cacheRef.current;

      // Already resolved or in-flight
      if (cache.has(key)) return;

      const canonical = registry.resolveType(type);
      const def = registry.getServiceDef(canonical);
      if (!def?.resolve || !def.serviceId || !runnerId) return;

      const port = panelPortMap.get(def.serviceId);
      if (!port) return;

      // Build the resolve URL through the tunnel proxy
      const resolvePath = def.resolve.replace("{id}", encodeURIComponent(id));
      const url = `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}${resolvePath}`;

      // Mark as loading
      cache.set(key, { loading: true });

      fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const data = (await res.json()) as SigilResolveData;
          cache.set(key, { data, loading: false });
        })
        .catch((err) => {
          cache.set(key, { loading: false, error: String(err) });
        });
    },
    [registry, panelPortMap, runnerId],
  );

  const contextValue = useMemo<SigilContextValue>(
    () => ({ registry, resolve, triggerResolve }),
    [registry, resolve, triggerResolve],
  );

  return <SigilCtx.Provider value={contextValue}>{children}</SigilCtx.Provider>;
}
