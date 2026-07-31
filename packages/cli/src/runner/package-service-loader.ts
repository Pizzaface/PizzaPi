/**
 * Package-origin runner service discovery (docs/specs/pi-pizzapi-overlay.md
 * §6, §7, §8, §9.2).
 *
 * Inspects ONLY packages already configured through pi settings/package
 * commands (`DefaultPackageManager.listConfiguredPackages()`) — this never
 * crawls `.pizzapi/npm` or `.pizzapi/git` directories directly, so an orphan
 * install directory that isn't in settings is never touched (§6.1). A
 * configured-but-not-installed source is skipped with one provenance-rich
 * warning; this loader never installs or prompts.
 *
 * Only user-scope packages mount daemon services (§6.2/§6.3) — a project
 * entry for the same identity never suppresses an already-configured
 * user-scope service, so project packages are read from
 * `listConfiguredPackages()` independently, purely to emit a "v1 does not
 * mount project services" warning when they declare any.
 *
 * Reading/validating a `pi.pizzapi` overlay (via `readOverlayManifest()`)
 * never imports code. For every declared service, the exact per-service
 * grant is checked BEFORE the entry module is dynamically imported — an
 * untrusted, disabled, or built-in-colliding service is never imported.
 * The confined entry (and panel) path is re-resolved immediately before
 * import/use rather than reusing the path resolved during the earlier
 * manifest-validation pass, and the loaded handler's runtime `id` must
 * equal the declared id or the service is rejected.
 */
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { computePackageIdentity, packageScopeBaseDir } from "../overlay/identity.js";
import { formatOverlayIssue, readOverlayManifest, resolveConfinedPath, type PackageProvenance } from "../overlay/manifest.js";
import { getGrantedServiceIds } from "../overlay/grants.js";
import { BUILTIN_SERVICE_IDS } from "./services/builtin-service-ids.js";
import { loadServiceModule } from "./service-loader.js";
import type { ServiceHandler } from "./service-handler.js";
import type { ServiceLoadError, ServiceManifest, ServicePluginResult } from "./service-loader.js";

export interface DiscoverPackageServicesOptions {
    /** Working directory used to resolve project-scope base dir and pass to the package manager. */
    cwd: string;
    /** Resolved agent dir (user-scope base dir for local package paths and settings). */
    agentDir: string;
    /** Service IDs to skip, regardless of grant — never imported. */
    disabledIds?: Set<string>;
}

export interface DiscoverPackageServicesResult {
    services: ServicePluginResult[];
    errors: ServiceLoadError[];
}

export async function discoverPackageServices(
    options: DiscoverPackageServicesOptions,
): Promise<DiscoverPackageServicesResult> {
    const { cwd, agentDir } = options;
    const disabledIds = options.disabledIds ?? new Set<string>();
    const services: ServicePluginResult[] = [];
    const errors: ServiceLoadError[] = [];
    // serviceId -> identity of the package that already won it, for the
    // package-vs-package collision warning (§8: stable first-configured wins).
    const winnerByServiceId = new Map<string, string>();

    let configured: ReturnType<DefaultPackageManager["listConfiguredPackages"]>;
    try {
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
        configured = packageManager.listConfiguredPackages();
    } catch (err) {
        errors.push({
            path: cwd,
            error: `package service discovery: failed to load configured packages: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { services, errors };
    }

    // ── Project-scope packages never mount daemon services in v1 (§6.3) ───
    // Warn only — never read further, never import.
    for (const pkg of configured) {
        if (pkg.scope !== "project" || !pkg.installedPath) continue;
        try {
            const identity = computePackageIdentity(pkg.source, packageScopeBaseDir("project", cwd, agentDir)).identity;
            const provenance: PackageProvenance = { identity, source: pkg.source, scope: "project" };
            const { overlay } = readOverlayManifest(pkg.installedPath, provenance);
            if (overlay?.services?.length) {
                errors.push({
                    path: pkg.installedPath,
                    error: `[${identity} (project: ${pkg.source})] declares runner service(s) [${overlay.services.map((s) => s.id).join(", ")}] — ` +
                        "project-scoped packages do not mount daemon services in schema v1; the session-side surface still loads after project trust.",
                });
            }
        } catch {
            // Best-effort warning only — never blocks discovery of other packages.
        }
    }

    // ── User-scope packages: the only scope eligible for daemon services ──
    const seenIdentities = new Set<string>();

    for (const pkg of configured) {
        if (pkg.scope !== "user") continue;
        // §6.1: explicit package order is stable — first configured entry
        // for a given identity wins if settings somehow list it twice.
        const identity = computePackageIdentity(pkg.source, agentDir).identity;
        if (seenIdentities.has(identity)) continue;
        seenIdentities.add(identity);

        if (!pkg.installedPath) {
            // Non-interactive onMissing=skip (§6.1): never install, never prompt.
            errors.push({
                path: identity,
                error: `[${identity} (user: ${pkg.source})] configured package is not installed — skipping (no install/prompt). Run \`pizza install ${pkg.source}\` to install it.`,
            });
            continue;
        }
        const packageRoot = pkg.installedPath;
        const provenance: PackageProvenance = { identity, source: pkg.source, scope: "user" };

        let overlayResult: ReturnType<typeof readOverlayManifest>;
        try {
            overlayResult = readOverlayManifest(packageRoot, provenance);
        } catch (err) {
            // Isolate: one unreadable package must not block the others.
            errors.push({ path: packageRoot, error: `[${identity}] failed to read overlay: ${err instanceof Error ? err.message : String(err)}` });
            continue;
        }
        const { overlay, present, issues } = overlayResult;
        if (present && !overlay) {
            // Malformed overlay is rejected as a unit (§5.2/§11) — never partially mount.
            for (const issue of issues) errors.push({ path: packageRoot, error: formatOverlayIssue(issue) });
            continue;
        }
        if (!overlay?.services?.length) continue;

        const grantedIds = getGrantedServiceIds(identity);

        for (const decl of overlay.services) {
            if (disabledIds.has(decl.id)) continue; // operationally disabled — never imported

            if (BUILTIN_SERVICE_IDS.has(decl.id)) {
                errors.push({
                    path: packageRoot,
                    error: `[${identity}] service "${decl.id}" collides with a reserved built-in service id — built-in wins, package service skipped.`,
                });
                continue;
            }

            const existingWinner = winnerByServiceId.get(decl.id);
            if (existingWinner) {
                errors.push({
                    path: packageRoot,
                    error: `[${identity}] service "${decl.id}" collides with already-registered package "${existingWinner}" — first configured package wins, skipped.`,
                });
                continue;
            }

            if (!grantedIds.has(decl.id)) {
                // Untrusted: NEVER imported (§9.2). Trust state is surfaced
                // through `pizza list`/`pizza config`, not service_announce.
                errors.push({
                    path: packageRoot,
                    error: `[${identity}] service "${decl.id}" is not granted — skipped (not imported). Run \`pizza config grant ${pkg.source} ${decl.id}\` to trust it.`,
                });
                continue;
            }

            // Revalidate the confined entry path immediately before import —
            // deliberately re-resolved here rather than reused from
            // readOverlayManifest()'s earlier validation pass.
            const resolvedEntry = resolveConfinedPath(packageRoot, decl.entry);
            if (!resolvedEntry.ok) {
                errors.push({ path: packageRoot, error: `[${identity}] service "${decl.id}" entry failed re-validation before import: ${resolvedEntry.message}` });
                continue;
            }

            let handler: ServiceHandler | null;
            try {
                handler = await loadServiceModule(resolvedEntry.absolutePath);
            } catch (err) {
                errors.push({ path: resolvedEntry.absolutePath, error: `[${identity}] service "${decl.id}" failed to import: ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            if (!handler) {
                errors.push({ path: resolvedEntry.absolutePath, error: `[${identity}] service "${decl.id}" entry does not export a valid ServiceHandler (needs default export with id, init, dispose).` });
                continue;
            }
            if (handler.id !== decl.id) {
                errors.push({ path: resolvedEntry.absolutePath, error: `[${identity}] service "${decl.id}" entry exports runtime id "${handler.id}", which does not match the declared id — rejected.` });
                continue;
            }

            // Revalidate panel.dir immediately before use, same TOCTOU
            // rationale as the entry path above.
            let panelDir: string | undefined;
            if (decl.panel?.dir) {
                const resolvedPanel = resolveConfinedPath(packageRoot, decl.panel.dir);
                if (!resolvedPanel.ok) {
                    errors.push({ path: packageRoot, error: `[${identity}] service "${decl.id}" panel.dir failed re-validation before use: ${resolvedPanel.message}` });
                } else {
                    panelDir = resolvedPanel.absolutePath;
                }
            }

            const manifest: ServiceManifest = {
                id: decl.id,
                label: decl.label,
                icon: decl.icon ?? "square",
                entry: decl.entry,
                ...(decl.panel ? { panel: { dir: panelDir, requires: decl.panel.requires } } : {}),
                ...(Array.isArray(decl.triggers) && decl.triggers.length > 0 ? { triggers: decl.triggers } : {}),
                ...(Array.isArray(decl.sigils) && decl.sigils.length > 0 ? { sigils: decl.sigils } : {}),
            };

            winnerByServiceId.set(decl.id, identity);
            services.push({
                handler,
                source: { origin: "package", path: resolvedEntry.absolutePath, pluginName: identity },
                manifest,
            });
        }
    }

    return { services, errors };
}
