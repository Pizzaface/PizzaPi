/**
 * Shared "configured pi packages" resolution — the single place that talks
 * to pi's `SettingsManager`/`DefaultPackageManager` and applies pi's own
 * project-over-user identity dedup (docs/packages.md "Scope and
 * Deduplication"). Reused by the CLI trust UX (cli-support.ts), daemon
 * package-service discovery, and session-side overlay mounting (agents,
 * rules, MCP) so the dedup/order rules can never drift between call sites.
 */
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computePackageIdentity, packageScopeBaseDir } from "./identity.js";

export type ConfiguredPkg = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];

export function packageManagerFor(cwd: string, agentDir: string): DefaultPackageManager {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

export interface DedupedConfiguredPackage {
    identity: string;
    pkg: ConfiguredPkg;
}

/**
 * Dedupe configured packages by normalized identity before display/mount —
 * project entries override user entries for the same identity, matching
 * pi's own scope/dedup rule. Preserves stable order: the winning entry
 * keeps the position of its first occurrence, only its content
 * (source/scope) is replaced.
 */
export function dedupeConfiguredPackages(
    configured: ConfiguredPkg[],
    cwd: string,
    agentDir: string,
): DedupedConfiguredPackage[] {
    const order: string[] = [];
    const byIdentity = new Map<string, DedupedConfiguredPackage>();
    for (const pkg of configured) {
        const baseDir = packageScopeBaseDir(pkg.scope, cwd, agentDir);
        const identity = computePackageIdentity(pkg.source, baseDir).identity;
        const existing = byIdentity.get(identity);
        if (!existing) {
            byIdentity.set(identity, { identity, pkg });
            order.push(identity);
            continue;
        }
        if (pkg.scope === "project" && existing.pkg.scope === "user") {
            byIdentity.set(identity, { identity, pkg });
        }
    }
    return order.map((identity) => byIdentity.get(identity)!);
}

/** Convenience: resolve + dedupe configured packages for `cwd`/`agentDir` in one call. */
export function listDedupedConfiguredPackages(cwd: string, agentDir: string): DedupedConfiguredPackage[] {
    const pm = packageManagerFor(cwd, agentDir);
    return dedupeConfiguredPackages(pm.listConfiguredPackages(), cwd, agentDir);
}
