/**
 * SigilContext — provides the SigilRegistry to sigil components.
 *
 * Wrap your message rendering tree in <SigilProvider> and sigil pills
 * will automatically pick up type configs and service definitions.
 */
import { createContext, useContext, useMemo } from "react";
import type { ServiceSigilDef } from "@pizzapi/protocol";
import { SigilRegistry, createRegistry } from "@/lib/sigils/registry";

const SigilRegistryContext = createContext<SigilRegistry>(createRegistry());

export function useSigilRegistry(): SigilRegistry {
  return useContext(SigilRegistryContext);
}

interface SigilProviderProps {
  sigilDefs: ServiceSigilDef[];
  children: React.ReactNode;
}

/**
 * Provider that creates a SigilRegistry from service definitions
 * and makes it available to all SigilPill components in the tree.
 */
export function SigilProvider({ sigilDefs, children }: SigilProviderProps) {
  const registry = useMemo(() => createRegistry(sigilDefs), [sigilDefs]);

  return (
    <SigilRegistryContext.Provider value={registry}>
      {children}
    </SigilRegistryContext.Provider>
  );
}
