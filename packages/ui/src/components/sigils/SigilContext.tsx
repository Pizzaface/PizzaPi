/**
 * SigilContext — provides the SigilRegistry and resolve infrastructure
 * to sigil components.
 *
 * Wrap your message rendering tree in <SigilProvider> and sigil pills
 * will automatically pick up type configs, service definitions, and
 * resolve enriched data from service endpoints.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ServiceSigilDef, ServicePanelInfo, SigilResolveData } from "@pizzapi/protocol";
import { SigilRegistry, createRegistry } from "@/lib/sigils/registry";
import { buildResolveUrl } from "@/lib/sigils/resolve-url";

export type { SigilResolveData } from "@pizzapi/protocol";

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
  /** Resolve one sigil to its plain-text representation. */
  resolveText: (type: string, id: string, params?: Record<string, string>) => Promise<string | undefined>;
  /**
   * Bumps when resolve state changes. Pills also depend on triggerResolve,
   * whose identity changes when infrastructure invalidates the cache.
   */
  generation: number;
}

const SigilCtx = createContext<SigilContextValue>({
  registry: createRegistry(),
  resolve: () => ({ loading: false }),
  triggerResolve: () => {},
  resolveText: async () => undefined,
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

export function useSigilTextResolver() {
  return useContext(SigilCtx).resolveText;
}

export function useSigilGeneration() {
  return useContext(SigilCtx).generation;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface SigilProviderProps {
  sigilDefs: ServiceSigilDef[];
  panels: ServicePanelInfo[];
  runnerId?: string;
  /** False while the runner or its relay feed is disconnected. */
  runnerOnline?: boolean;
  /** Working directory of the session being viewed — lets services resolve
   *  sigils against the session's project (e.g. GitHub repo auto-detection). */
  sessionCwd?: string;
  children: React.ReactNode;
}

/**
 * Provider that creates a SigilRegistry from service definitions
 * and manages resolve endpoint calls for enriching sigil display data.
 */
function resolveTextValue(data: SigilResolveData | undefined): string | undefined {
  for (const value of [data?.text, data?.title, data?.url]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function SigilProvider({ sigilDefs, panels, runnerId, runnerOnline = true, sessionCwd, children }: SigilProviderProps) {
  const registry = useMemo(() => createRegistry(sigilDefs), [sigilDefs]);

  // A reconnect invalidates failed lookups even when all metadata is unchanged.
  const { cache, retryTimers, inFlight } = useMemo(() => ({
    cache: new Map<string, SigilResolveState>(),
    retryTimers: new Set<ReturnType<typeof setTimeout>>(),
    inFlight: new Map<string, Promise<SigilResolveData | undefined>>(),
  }), [panels, runnerId, runnerOnline, sigilDefs, sessionCwd]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => () => {
    // Retire pending requests too: their completion must not overwrite new data.
    cache.clear();
    inFlight.clear();
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
  }, [cache, inFlight, retryTimers]);

  // Build panel port lookup: serviceId → port
  const panelPortMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of panels) map.set(p.serviceId, p.port);
    return map;
  }, [panels]);

  const resolve = useCallback(
    (type: string, id: string): SigilResolveState => {
      const canonical = registry.resolveType(type);
      const key = `${canonical}:${id}:${sessionCwd ?? ""}`;
      return cache.get(key) ?? { loading: false };
    },
    [cache, registry, sessionCwd],
  );

  const triggerResolve = useCallback(
    (type: string, id: string, params?: Record<string, string>) => {
      const canonical = registry.resolveType(type);
      const key = `${canonical}:${id}:${sessionCwd ?? ""}`;
      // Failed entries stay cached after the bounded retries, until reconnect.
      if (!runnerOnline || cache.has(key)) return;

      const def = registry.getServiceDef(canonical);
      if (!def?.resolve || !def.serviceId || !runnerId) return;

      // Prefer the panel port (services with a UI panel), then fall back to
      // resolvePort (panel-less services like the built-in time service that
      // only run an HTTP server for sigil resolution).
      const port = panelPortMap.get(def.serviceId) ?? def.resolvePort;
      if (!port) return;

      // Build the resolve URL through the tunnel proxy. `cwd` (the session's
      // project dir) is infrastructure-provided, not a sigil param — services
      // use it for per-session repo detection.
      const url = buildResolveUrl({
        runnerId,
        port,
        resolvePath: def.resolve.replace("{id}", encodeURIComponent(id)),
        params,
        sessionCwd,
      });

      const pending = { loading: true };
      cache.set(key, pending);
      setGeneration((g) => g + 1);

      const fetchData = async (attempt: number): Promise<SigilResolveData | undefined> => {
        if (cache.get(key) !== pending) return undefined;
        let retryable = true; // A rejected fetch is a transport failure.
        try {
          const res = await fetch(url);
          retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const data = (await res.json()) as SigilResolveData;
          if (cache.get(key) !== pending) return undefined;
          cache.set(key, { data, loading: false });
          setGeneration((g) => g + 1);
          return data;
        } catch (err) {
          if (cache.get(key) !== pending) return undefined;
          // ponytail: three backoff retries cover tunnel warm-up, not permanent errors.
          if (retryable && attempt < 3) {
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                retryTimers.delete(timer);
                void fetchData(attempt + 1).then(resolve);
              }, 1000 * 2 ** attempt);
              retryTimers.add(timer);
            });
          }
          cache.set(key, { loading: false, error: String(err) });
          setGeneration((g) => g + 1);
          return undefined;
        }
      };
      const request = fetchData(0);
      inFlight.set(key, request);
      void request.finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    },
    [cache, inFlight, retryTimers, registry, panelPortMap, runnerId, runnerOnline, sessionCwd],
  );

  const resolveText = useCallback(
    async (type: string, id: string, params?: Record<string, string>): Promise<string | undefined> => {
      const canonical = registry.resolveType(type);
      const key = `${canonical}:${id}:${sessionCwd ?? ""}`;
      const cached = cache.get(key);
      const data = cached?.data ?? (inFlight.get(key) ? await inFlight.get(key) : undefined);
      if (!data) {
        triggerResolve(canonical, id, params);
        const request = inFlight.get(key);
        if (!request) return undefined;
        return resolveTextValue(await request);
      }
      return resolveTextValue(data);
    },
    [cache, inFlight, registry, sessionCwd, triggerResolve],
  );

  const contextValue = useMemo<SigilContextValue>(
    () => ({ registry, resolve, triggerResolve, resolveText, generation }),
    [registry, resolve, triggerResolve, resolveText, generation],
  );

  return <SigilCtx.Provider value={contextValue}>{children}</SigilCtx.Provider>;
}
