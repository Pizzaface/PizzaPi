/**
 * Shared "configured pi packages" resolution — the single place that talks
 * to pi's `SettingsManager`/`DefaultPackageManager` and applies pi's own
 * project-over-user identity dedup (docs/packages.md "Scope and
 * Deduplication"). Reused by the CLI trust UX (cli-support.ts), daemon
 * package-service discovery, and session-side overlay mounting (agents,
 * rules, MCP) so the dedup/order rules can never drift between call sites.
 */
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import { computePackageIdentity, packageScopeBaseDir } from "./identity.js";

const log = createLogger("overlay/resolve");

export type ConfiguredPkg = ReturnType<DefaultPackageManager["listConfiguredPackages"]>[number];

// Warn-once-per-process dedup for SettingsManager parse errors, keyed by
// `scope:message` — packageManagerFor() runs on nearly every session-side
// overlay resolution call (subagent invocations, MCP loads/reloads, rules
// extension setup), so without dedup a single corrupt settings.json would
// spam a warning on every one of those instead of surfacing once.
const warnedSettingsErrors = new Set<string>();

function warnSettingsErrorsOnce(settingsManager: SettingsManager): void {
    for (const { scope, error } of settingsManager.drainErrors()) {
        const key = `${scope}:${error.message}`;
        if (warnedSettingsErrors.has(key)) continue;
        warnedSettingsErrors.add(key);
        // pi's SettingsManager loads global/project scopes independently
        // (settings-manager.js: separate try/catch per scope) — a corrupt
        // scope here never blocks the other from loading; this only
        // surfaces the corruption so it doesn't silently read back as "no
        // packages configured" for the broken scope.
        log.warn(`${scope} pi settings failed to parse — treating ${scope}-scope configured packages as empty until fixed: ${error.message}`);
    }
}

/**
 * `projectTrusted` MUST be the caller's explicit, persisted trust decision
 * (see config/io.ts `resolveExplicitProjectTrust`) — never omitted. pi's
 * `SettingsManager.create()` defaults to `projectTrusted: true` when the
 * option is left out, which would silently re-trust an untrusted repo's
 * project-scope configured packages (and therefore its `pi.pizzapi`
 * overlay) for every session-side caller of this function.
 */
export function packageManagerFor(cwd: string, agentDir: string, projectTrusted: boolean): DefaultPackageManager {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    warnSettingsErrorsOnce(settingsManager);
    return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

export interface DedupedConfiguredPackage {
    identity: string;
    pkg: ConfiguredPkg;
}

/**
 * Dedupe configured packages by normalized identity before display/mount —
 * project entries override user entries for the same identity, matching
 * pi's own scope/dedup rule. Preserves stable order WITHIN the winning
 * scope: two passes — first decide the winner per identity (project beats
 * user), then walk `configured` again and record each identity's position
 * at the winner's OWN occurrence (not the loser's). A single-pass "replace
 * in place" approach anchors a project winner at whatever position the user
 * entry it replaced happened to occupy, which can reorder (or even reverse)
 * project entries relative to their actual settings-file order whenever the
 * user- and project-scope lists don't share the same relative ordering for
 * shared identities (e.g. user=[A,B], project=[B',A'] would previously
 * yield [A',B'] — reversed from the project settings file).
 */
export function dedupeConfiguredPackages(
    configured: ConfiguredPkg[],
    cwd: string,
    agentDir: string,
): DedupedConfiguredPackage[] {
    const identities = configured.map(
        (pkg) => computePackageIdentity(pkg.source, packageScopeBaseDir(pkg.scope, cwd, agentDir)).identity,
    );

    const winners = new Map<string, ConfiguredPkg>();
    configured.forEach((pkg, i) => {
        const identity = identities[i];
        const existing = winners.get(identity);
        if (!existing || pkg.scope === "project") winners.set(identity, pkg);
    });

    const order: string[] = [];
    const seen = new Set<string>();
    configured.forEach((pkg, i) => {
        const identity = identities[i];
        if (seen.has(identity) || winners.get(identity) !== pkg) return;
        seen.add(identity);
        order.push(identity);
    });

    return order.map((identity) => ({ identity, pkg: winners.get(identity)! }));
}

/** Convenience: resolve + dedupe configured packages for `cwd`/`agentDir` in one call. */
export function listDedupedConfiguredPackages(
    cwd: string,
    agentDir: string,
    projectTrusted: boolean,
): DedupedConfiguredPackage[] {
    const pm = packageManagerFor(cwd, agentDir, projectTrusted);
    return dedupeConfiguredPackages(pm.listConfiguredPackages(), cwd, agentDir);
}
