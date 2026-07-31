/**
 * Global `overlayServiceGrants` CRUD + state resolution.
 *
 * Grants live only in ~/.pizzapi/config.json (global) — project packages
 * never receive daemon grants in schema v1 (docs/specs/pi-pizzapi-overlay.md §6.3).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OverlayServiceGrant } from "../config/types.js";
import { globalConfigDir, loadGlobalConfig, saveGlobalConfig } from "../config/io.js";

export type ServiceGrantState = "granted" | "disabled" | "untrusted";

export function getOverlayServiceGrants(): OverlayServiceGrant[] {
    const grants = loadGlobalConfig().overlayServiceGrants;
    return Array.isArray(grants) ? grants.filter((g): g is OverlayServiceGrant => isValidGrant(g)) : [];
}

function isValidGrant(g: unknown): g is OverlayServiceGrant {
    return (
        !!g &&
        typeof g === "object" &&
        typeof (g as OverlayServiceGrant).package === "string" &&
        Array.isArray((g as OverlayServiceGrant).services)
    );
}

export function getGrantedServiceIds(identity: string): Set<string> {
    const grant = getOverlayServiceGrants().find((g) => g.package === identity);
    return new Set(grant?.services ?? []);
}

/** Grant the given service IDs for a package identity (union with any existing grant). */
export function grantServices(identity: string, serviceIds: string[]): OverlayServiceGrant[] {
    const grants = getOverlayServiceGrants();
    const existing = grants.find((g) => g.package === identity);
    if (existing) {
        existing.services = [...new Set([...existing.services, ...serviceIds])];
    } else {
        grants.push({ package: identity, services: [...new Set(serviceIds)] });
    }
    persist(grants);
    return grants;
}

/** Revoke the given service IDs for a package identity. Removes the entry entirely once empty. */
export function revokeServices(identity: string, serviceIds: string[]): OverlayServiceGrant[] {
    const revokeSet = new Set(serviceIds);
    const grants = getOverlayServiceGrants()
        .map((g) => (g.package === identity ? { ...g, services: g.services.filter((s) => !revokeSet.has(s)) } : g))
        .filter((g) => g.services.length > 0);
    persist(grants);
    return grants;
}

/**
 * Remove grants whose package identity is absent from `validIdentities`.
 * Call at daemon start/reconfiguration (§7.2) — authoritative even when
 * `pi remove` bypassed the pizza wrapper.
 */
export function pruneOrphanGrants(validIdentities: ReadonlySet<string>): OverlayServiceGrant[] {
    const grants = getOverlayServiceGrants();
    const kept = grants.filter((g) => validIdentities.has(g.package));
    const removed = grants.filter((g) => !validIdentities.has(g.package));
    if (removed.length > 0) persist(kept);
    return removed;
}

function persist(grants: OverlayServiceGrant[]): void {
    if (grants.length > 0) {
        saveGlobalConfig({ overlayServiceGrants: grants });
        return;
    }
    // saveGlobalConfig only merges/overwrites keys — it cannot delete one.
    // Write the full object directly, same pattern as toggleMcpServer().
    const dir = globalConfigDir();
    const path = join(dir, "config.json");
    const rest = loadGlobalConfig();
    delete rest.overlayServiceGrants;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(rest, null, 2), { encoding: "utf-8", mode: 0o600 });
    chmodSync(path, 0o600);
}

/**
 * Resolve a service's trust state: `untrusted` (no grant), `disabled`
 * (granted but operationally off via `disabledRunnerServices`), or `granted`.
 */
export function resolveServiceGrantState(
    identity: string,
    serviceId: string,
    disabledRunnerServices: readonly string[] = [],
): ServiceGrantState {
    if (!getGrantedServiceIds(identity).has(serviceId)) return "untrusted";
    return disabledRunnerServices.includes(serviceId) ? "disabled" : "granted";
}
