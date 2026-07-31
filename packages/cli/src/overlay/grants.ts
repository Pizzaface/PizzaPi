/**
 * Global `overlayServiceGrants` CRUD + state resolution.
 *
 * Grants live only in ~/.pizzapi/config.json (global) — project packages
 * never receive daemon grants in schema v1 (docs/specs/pi-pizzapi-overlay.md §6.3).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { OverlayServiceGrant } from "../config/types.js";
import { globalConfigDir, loadGlobalConfig, saveGlobalConfig } from "../config/io.js";
import { computePackageIdentity } from "./identity.js";
import { readOverlayManifest, type PackageProvenance } from "./manifest.js";

export type ServiceGrantState = "granted" | "disabled" | "untrusted";

export function getOverlayServiceGrants(): OverlayServiceGrant[] {
    const grants = loadGlobalConfig().overlayServiceGrants;
    return Array.isArray(grants) ? grants.filter((g): g is OverlayServiceGrant => isValidGrant(g)) : [];
}

function isValidGrant(g: unknown): g is OverlayServiceGrant {
    if (!g || typeof g !== "object") return false;
    const pkg = (g as OverlayServiceGrant).package;
    const services = (g as OverlayServiceGrant).services;
    return (
        typeof pkg === "string" &&
        pkg.length > 0 &&
        Array.isArray(services) &&
        services.every((s) => typeof s === "string" && s.length > 0)
    );
}

export function getGrantedServiceIds(identity: string): Set<string> {
    const grant = getOverlayServiceGrants().find((g) => g.package === identity);
    return new Set(grant?.services ?? []);
}

/** Grant the given service IDs for a package identity (union with any existing grant). */
export function grantServices(identity: string, serviceIds: string[]): OverlayServiceGrant[] {
    // Check parsability up front, before reading: once the config is
    // corrupt, reads silently degrade to "no grants" (see
    // assertGlobalConfigParsable()'s docstring), which would otherwise make
    // this look like a fresh grant instead of a refused write.
    assertGlobalConfigParsable();
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
    // Same reasoning as grantServices(): a corrupt config reads back as "no
    // grants", which would otherwise be indistinguishable from a genuine
    // no-op revoke. Check parsability first so a real (unreadable) grant
    // isn't silently treated as absent.
    assertGlobalConfigParsable();
    const revokeSet = new Set(serviceIds);
    const grants = getOverlayServiceGrants();
    const target = grants.find((g) => g.package === identity);
    // No-op: nothing would actually change, so don't touch disk (and don't
    // trip the malformed-config guard for a write that was never needed).
    if (!target || !target.services.some((s) => revokeSet.has(s))) {
        return grants;
    }
    const next = grants
        .map((g) => (g.package === identity ? { ...g, services: g.services.filter((s) => !revokeSet.has(s)) } : g))
        .filter((g) => g.services.length > 0);
    persist(next);
    return next;
}

/** Per-identity view of what the upstream package manager currently configures. */
export interface ConfiguredPackageGrantInfo {
    /**
     * Service IDs currently declared by this package's valid `pi.pizzapi`
     * overlay manifest. `null` means the identity is configured but its
     * installed path is temporarily missing or its overlay could not be
     * read cleanly — reconcileGrants() must treat that fail-closed and
     * leave any existing grant untouched rather than deleting it.
     */
    declaredServiceIds: Set<string> | null;
}

/**
 * Build the configured-identity map reconcileGrants() needs from the
 * upstream PackageManager's *user*-scope configured packages (grants are
 * user-scope only in schema v1 — see module docstring) plus each package's
 * manifest, read through the shared identity/manifest helpers.
 */
export function buildConfiguredGrantIdentities(cwd: string, agentDir: string): Map<string, ConfiguredPackageGrantInfo> {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const map = new Map<string, ConfiguredPackageGrantInfo>();

    for (const pkg of packageManager.listConfiguredPackages()) {
        if (pkg.scope !== "user") continue; // grants never apply to project-scoped packages (§6.3)
        const identity = computePackageIdentity(pkg.source, agentDir).identity;

        if (!pkg.installedPath) {
            // Fail-closed: identity is configured but its install path is
            // temporarily missing (e.g. npm store not yet warmed). Do not
            // delete or trim its grant.
            map.set(identity, { declaredServiceIds: null });
            continue;
        }

        let declaredServiceIds: Set<string> | null;
        try {
            const provenance: PackageProvenance = { identity, source: pkg.source, scope: pkg.scope };
            const { overlay, present, issues } = readOverlayManifest(pkg.installedPath, provenance);
            if (issues.length > 0 || !existsSync(join(pkg.installedPath, "package.json"))) {
                // The configured install exists but its package manifest cannot
                // be read cleanly. Preserve grants fail-closed until repaired.
                declaredServiceIds = null;
            } else if (!present) {
                // Readable package.json with no pi.pizzapi key: no services.
                declaredServiceIds = new Set();
            } else if (overlay) {
                declaredServiceIds = new Set(overlay.services?.map((s) => s.id) ?? []);
            } else {
                // Overlay present but invalid/unreadable as a unit — fail-closed.
                declaredServiceIds = null;
            }
        } catch {
            declaredServiceIds = null;
        }
        map.set(identity, { declaredServiceIds });
    }

    return map;
}

/** One removal or trim applied by reconcileGrants(), for daemon-side logging. */
export interface GrantReconciliationRemoval {
    package: string;
    /** Service IDs revoked from this package's grant (all of them when fullyRemoved). */
    removedServiceIds: string[];
    /** True when the whole grant entry was dropped (unconfigured, or no declared IDs remain). */
    fullyRemoved: boolean;
}

/**
 * Reconcile grants against `configured` — the currently configured USER
 * package identities and each valid manifest's currently declared service
 * IDs (built via buildConfiguredGrantIdentities()). Call at daemon
 * start/reconfiguration (§7.2) — authoritative even when `pi remove`
 * bypassed the pizza wrapper.
 *
 * - Identity absent from `configured` (package no longer configured at
 *   all): grant removed entirely.
 * - Identity present with `declaredServiceIds: null` (install path
 *   missing / overlay unreadable): grant left untouched, fail-closed.
 * - Identity present with a real declared-IDs set: granted service IDs no
 *   longer declared are trimmed (removing/re-adding a service requires a
 *   fresh grant); the entry is dropped entirely if nothing remains.
 */
export function reconcileGrants(configured: ReadonlyMap<string, ConfiguredPackageGrantInfo>): GrantReconciliationRemoval[] {
    assertGlobalConfigParsable();
    const grants = getOverlayServiceGrants();
    const kept: OverlayServiceGrant[] = [];
    const removals: GrantReconciliationRemoval[] = [];

    for (const g of grants) {
        const info = configured.get(g.package);
        if (!info) {
            removals.push({ package: g.package, removedServiceIds: [...g.services], fullyRemoved: true });
            continue;
        }
        if (info.declaredServiceIds === null) {
            kept.push(g); // fail-closed: keep as-is
            continue;
        }
        const declared = info.declaredServiceIds;
        const remaining = g.services.filter((s) => declared.has(s));
        const trimmedOut = g.services.filter((s) => !declared.has(s));
        if (trimmedOut.length === 0) {
            kept.push(g);
            continue;
        }
        if (remaining.length > 0) {
            kept.push({ package: g.package, services: remaining });
        }
        removals.push({ package: g.package, removedServiceIds: trimmedOut, fullyRemoved: remaining.length === 0 });
    }

    if (removals.length > 0) persist(kept);
    return removals;
}

/**
 * Refuse to write when ~/.pizzapi/config.json exists but is not valid
 * JSON — every write path below (grant/revoke/reconcile) goes through
 * persist(), so this guard is the single choke point that keeps a
 * corrupt global config's bytes untouched instead of silently replacing
 * it with `{ overlayServiceGrants: [...] }` (readJsonSafe() would
 * otherwise swallow the parse error and return `{}`, discarding whatever
 * else was in the file).
 */
function assertGlobalConfigParsable(): void {
    const path = join(globalConfigDir(), "config.json");
    if (!existsSync(path)) return;
    let text: string;
    try {
        text = readFileSync(path, "utf-8");
    } catch (err) {
        throw new Error(`overlay grants: cannot read global config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level value must be an object");
    } catch {
        throw new Error(
            `overlay grants: refusing to modify malformed global config at ${path} — ` +
            "the file exists but is not valid JSON. Fix or remove it by hand before granting/revoking package trust.",
        );
    }
}

function persist(grants: OverlayServiceGrant[]): void {
    assertGlobalConfigParsable();
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
