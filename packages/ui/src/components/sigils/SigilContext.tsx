/**
 * SigilContext — provides the SigilRegistry and resolve infrastructure
 * to sigil components.
 *
 * Wrap your message rendering tree in <SigilProvider> and sigil pills
 * will automatically pick up type configs, service definitions, and
 * resolve enriched data from service endpoints.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  /** Read current resolve state for a sigil. */
  resolve: (type: string, id: string) => SigilResolveState;
  /** Kick off a resolve fetch (no-op if already cached). */
  triggerResolve: (type: string, id: string, params?: Record<string, string>) => void;
  /**
   * Monotonically increasing counter that bumps whenever infrastructure
   * changes (server restart, reconnect) or resolve data arrives.
   * Pills include this in useEffect deps to re-trigger resolve after cache invalidation.
   */
  generation: number;
}

const SigilCtx = createContext<SigilContextValue>({
  registry: createRegistry(),
  resolve: () => ({ loading: false }),
  triggerResolve: () => {},
  generation: 0,
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

export function useSigilGeneration() {
  return useContext(SigilCtx).generation;
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

  // Resolve cache: keyed by "gen:type:id". Lives in a ref for instant reads.
  const cacheRef = useRef(new Map<string, SigilResolveState>());
  const [generation, setGeneration] = useState(0);

  // Build panel port lookup: serviceId → port
  const panelPortMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of panels) map.set(p.serviceId, p.port);
    return map;
  }, [panels]);

  // Bump generation and clear cache when infrastructure changes.
  // This invalidates all cached entries and causes pills to re-trigger
  // resolve via the generation dep in their useEffect.
  const prevInfraRef = useRef({ panels, runnerId, sigilDefs });
  useEffect(() => {
    const prev = prevInfraRef.current;
    // Skip the initial mount — only invalidate on actual changes
    if (prev.panels !== panels || prev.runnerId !== runnerId || prev.sigilDefs !== sigilDefs) {
      cacheRef.current.clear();
      setGeneration((g) => g + 1);
    }
    prevInfraRef.current = { panels, runnerId, sigilDefs };
  }, [panels, runnerId, sigilDefs]);

  const resolve = useCallback(
    (type: string, id: string): SigilResolveState => {
      const key = `${type}:${id}`;
      return cacheRef.current.get(key) ?? { loading: false };
    },
    [],
  );

  const triggerResolve = useCallback(
    (type: string, id: string, params?: Record<string, string>) => {
      const key = `${type}:${id}`;
      const cache = cacheRef.current;

      // Already resolved or in-flight
      if (cache.has(key)) return;

      const canonical = registry.resolveType(type);
      const def = registry.getServiceDef(canonical);
      if (!def?.resolve || !def.serviceId || !runnerId) return;

      const port = panelPortMap.get(def.serviceId);
      if (!port) return;

      // Build the resolve URL through the tunnel proxy, forwarding params as query string
      const resolvePath = def.resolve.replace("{id}", encodeURIComponent(id));
      const qs = params && Object.keys(params).length > 0
        ? "?" + new URLSearchParams(
            Object.entries(params).filter(([k]) => !["label", "link", "href"].includes(k)),
          ).toString()
        : "";
      const url = `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}${resolvePath}${qs}`;

      // Mark as loading
      cache.set(key, { loading: true });
      setGeneration((g) => g + 1);

      fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const data = (await res.json()) as SigilResolveData;
          cache.set(key, { data, loading: false });
          setGeneration((g) => g + 1);
        })
        .catch((err) => {
          cache.set(key, { loading: false, error: String(err) });
          setGeneration((g) => g + 1);
        });
    },
    [registry, panelPortMap, runnerId],
  );

  const contextValue = useMemo<SigilContextValue>(
    () => ({ registry, resolve, triggerResolve, generation }),
    [registry, resolve, triggerResolve, generation],
  );

  return <SigilCtx.Provider value={contextValue}>{children}</SigilCtx.Provider>;
}
