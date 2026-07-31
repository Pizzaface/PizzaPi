/**
 * `pizza install|list|config` overlay trust UX — flag stripping, install-time
 * grant prompts, and list/config grant-state rendering.
 *
 * All overlay reading goes through readOverlayManifest() (manifest.ts); this
 * module only adds the CLI-facing prompt/print/grant plumbing described in
 * docs/specs/pi-pizzapi-overlay.md §7.3.
 */
import { createInterface } from "node:readline";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { c } from "../cli-colors.js";
import { loadGlobalConfig } from "../config/io.js";
import { computePackageIdentity, packageScopeBaseDir } from "./identity.js";
import { formatOverlayIssue, readOverlayManifest, type OverlayReadResult, type PackageProvenance } from "./manifest.js";
import { getGrantedServiceIds, grantServices, revokeServices, resolveServiceGrantState } from "./grants.js";
import { dedupeConfiguredPackages, packageManagerFor, type ConfiguredPkg } from "./resolve.js";
import { defaultStatePath, isPidRunning, type RunnerState } from "../runner/runner-state.js";
import { existsSync, readFileSync } from "node:fs";

export interface DaemonServiceFlagResult {
    args: string[];
    /** true = --allow-daemon-services, false = --no-allow-daemon-services, undefined = neither given. */
    allowDaemonServices: boolean | undefined;
}

/** Pre-parse and strip --allow-daemon-services / --no-allow-daemon-services, mirroring stripCwdFlag(). */
export function stripDaemonServiceFlags(args: string[]): DaemonServiceFlagResult {
    let allowDaemonServices: boolean | undefined;
    const out: string[] = [];
    for (const arg of args) {
        if (arg === "--allow-daemon-services") {
            allowDaemonServices = true;
            continue;
        }
        if (arg === "--no-allow-daemon-services") {
            allowDaemonServices = false;
            continue;
        }
        out.push(arg);
    }
    return { args: out, allowDaemonServices };
}

function firstPositional(args: string[]): string | undefined {
    return args.slice(1).find((a) => !a.startsWith("-"));
}

function isLocalScopeInstall(args: string[]): boolean {
    return args.includes("-l") || args.includes("--local");
}

/** Best-effort: is a runner daemon currently running? Informational only — no new IPC. */
function describeRunningDaemon(): string {
    try {
        const path = defaultStatePath();
        if (!existsSync(path)) return "Grant changes will take effect the next time the daemon starts.";
        const state = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunnerState>;
        const pid = typeof state.pid === "number" ? state.pid : 0;
        if (pid > 0 && isPidRunning(pid)) {
            return "A runner daemon is currently running — restart it (or wait for the next scheduled restart) to apply this grant change; automatic reconciliation lands with daemon package-service discovery.";
        }
    } catch {
        // best-effort only
    }
    return "Grant changes will take effect the next time the daemon starts.";
}

function askYesNo(question: string): Promise<boolean> {
    const iface = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        iface.question(question, (answer) => {
            iface.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

interface ConfiguredMatch {
    provenance: PackageProvenance;
    installedPath: string;
}

/**
 * Resolve `source` to a package pi actually has *configured* at `scope` —
 * matched by normalized identity, using the scope-aware base dir pi itself
 * resolves relative local paths against (agent dir for user, `<cwd>/.pizzapi`
 * for project; see identity.ts `packageScopeBaseDir`).
 *
 * P1: `DefaultPackageManager.getInstalledPath()` alone does NOT check
 * configuration for local sources — it just resolves the path and checks
 * `existsSync`. Reading an overlay (and especially granting daemon service
 * trust) must never be reachable for an arbitrary local directory that
 * merely exists on disk; it must be a package the user actually installed
 * via `pi install`/`pizza install` (i.e. present in
 * `listConfiguredPackages()`). This is the single choke point every
 * overlay-reading CLI path (install, list, config grant/revoke, update)
 * goes through.
 */
function findConfiguredOverlaySource(
    pm: DefaultPackageManager,
    source: string,
    scope: "user" | "project",
    cwd: string,
    agentDir: string,
): ConfiguredMatch | undefined {
    const baseDir = packageScopeBaseDir(scope, cwd, agentDir);
    const identity = computePackageIdentity(source, baseDir).identity;
    for (const pkg of pm.listConfiguredPackages()) {
        if (pkg.scope !== scope || !pkg.installedPath) continue;
        const pkgBaseDir = packageScopeBaseDir(pkg.scope, cwd, agentDir);
        if (computePackageIdentity(pkg.source, pkgBaseDir).identity !== identity) continue;
        return { provenance: { identity, source: pkg.source, scope }, installedPath: pkg.installedPath };
    }
    return undefined;
}

function readOverlayFor(cwd: string, agentDir: string, source: string, scope: "user" | "project"): { provenance: PackageProvenance; result: OverlayReadResult } | undefined {
    const pm = packageManagerFor(cwd, agentDir);
    const match = findConfiguredOverlaySource(pm, source, scope, cwd, agentDir);
    if (!match) return undefined;
    return { provenance: match.provenance, result: readOverlayManifest(match.installedPath, match.provenance) };
}

/**
 * Run after a successful upstream `pizza install <source>`. Validates the
 * overlay and, for user-scoped packages that declare services, grants or
 * warns per §7.3. Returns the exit code the CLI should use (0 unless the
 * overlay is malformed).
 */
export async function handlePostInstallOverlay(args: string[], cwd: string, agentDir: string, allowDaemonServices: boolean | undefined): Promise<number> {
    const source = firstPositional(args);
    if (!source) return 0;
    const scope: "user" | "project" = isLocalScopeInstall(args) ? "project" : "user";

    const found = readOverlayFor(cwd, agentDir, source, scope);
    if (!found) return 0; // not resolvable (e.g. install itself failed) — nothing to validate
    const { provenance, result } = found;

    if (result.present && result.overlay === null) {
        console.error(`\n${c.error("✗")} pi.pizzapi overlay is invalid for ${c.cmd(provenance.identity)}:\n`);
        for (const iss of result.issues) {
            console.error(`  ${c.error("•")} ${formatOverlayIssue(iss)}`);
        }
        console.error(
            `\n${c.warning("Note:")} the pi-native package install may remain in place (upstream install is not transactional).\n` +
            `No daemon service grant was created. Run ${c.cmd(`pizza remove ${source}`)} to undo the install.\n`,
        );
        return 1;
    }

    if (!result.overlay || !result.overlay.services || result.overlay.services.length === 0) {
        return 0;
    }

    const declaredIds = result.overlay.services.map((s) => s.id);

    if (scope === "project") {
        console.log(
            `\n${c.warning("Note:")} ${c.cmd(provenance.identity)} declares runner service(s) [${declaredIds.join(", ")}], ` +
            `but project-scoped packages do not mount daemon services in schema v1. The session-side surface (extensions/skills/agents/rules/mcp) still loads after project trust.\n`,
        );
        return 0;
    }

    if (allowDaemonServices === true) {
        grantServices(provenance.identity, declaredIds);
        console.log(`\n${c.success("✓")} Granted daemon service(s) [${declaredIds.join(", ")}] for ${c.cmd(provenance.identity)}.`);
        console.log(`  ${describeRunningDaemon()}\n`);
        return 0;
    }

    if (allowDaemonServices === false) {
        console.log(
            `\n${c.warning("Note:")} ${c.cmd(provenance.identity)} declares runner service(s) [${declaredIds.join(", ")}] — left ${c.warning("untrusted")} (--no-allow-daemon-services). ` +
            `Run ${c.cmd(`pizza config grant ${source}`)} to trust them later.\n`,
        );
        return 0;
    }

    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (interactive) {
        console.log(`\n${c.cmd(provenance.identity)} declares runner service(s):`);
        for (const svc of result.overlay.services) console.log(`  - ${svc.id} (${svc.label})`);
        const grant = await askYesNo(`Grant daemon access to these service(s) now? [y/N] `);
        if (grant) {
            grantServices(provenance.identity, declaredIds);
            console.log(`${c.success("✓")} Granted. ${describeRunningDaemon()}\n`);
        } else {
            console.log(`Left untrusted. Run ${c.cmd(`pizza config grant ${source}`)} to trust them later.\n`);
        }
        return 0;
    }

    console.log(
        `\n${c.warning("Note:")} ${c.cmd(provenance.identity)} declares runner service(s) [${declaredIds.join(", ")}] — installed but left ${c.warning("untrusted")} ` +
        `(non-interactive install with no --allow-daemon-services/--no-allow-daemon-services flag). Run ${c.cmd(`pizza config grant ${source}`)} to trust them.\n`,
    );
    return 0;
}

/** Render the overlay/service-trust section appended to `pizza list` output. */
export function renderOverlaySummary(cwd: string, agentDir: string): void {
    const pm = packageManagerFor(cwd, agentDir);
    const configured = pm.listConfiguredPackages();
    if (configured.length === 0) return;

    const deduped = dedupeConfiguredPackages(configured, cwd, agentDir);
    const disabledRunnerServices = loadGlobalConfig().disabledRunnerServices ?? [];
    const lines: string[] = [];

    for (const { identity, pkg } of deduped) {
        if (!pkg.installedPath) continue;
        const provenance: PackageProvenance = { identity, source: pkg.source, scope: pkg.scope };
        const { overlay, present, issues } = readOverlayManifest(pkg.installedPath, provenance);

        if (present && !overlay) {
            lines.push(`${c.warning("⚠")} ${identity} — invalid pi.pizzapi overlay (${issues.length} issue(s); run \`pizza install ${pkg.source}\` again to see details)`);
            continue;
        }
        if (!overlay) continue;

        const parts: string[] = [];
        if (overlay.agents?.length) parts.push(`agents:${overlay.agents.length}`);
        if (overlay.rules?.length) parts.push(`rules:${overlay.rules.length}`);
        if (overlay.mcp) parts.push("mcp");
        if (overlay.services?.length) {
            const svcStates = overlay.services
                .map((s) => {
                    const state = pkg.scope === "project" ? "untrusted (project, v1)" : resolveServiceGrantState(identity, s.id, disabledRunnerServices);
                    return `${s.id}:${state}`;
                })
                .join(", ");
            parts.push(`services:[${svcStates}]`);
        }
        if (parts.length > 0) {
            lines.push(`${c.accent("●")} ${identity} (${pkg.scope}) — ${parts.join("  ")}`);
        }
    }

    if (lines.length > 0) {
        console.log(`\n${c.label("PizzaPi overlay:")}`);
        for (const line of lines) console.log(`  ${line}`);
        console.log();
    }
}

/** `pizza config grant|revoke <source> [serviceId...]`. Returns undefined if args aren't a grant/revoke subcommand. */
export async function runOverlayConfigSubcommand(args: string[], cwd: string, agentDir: string): Promise<number | undefined> {
    const sub = args[1];
    if (sub !== "grant" && sub !== "revoke") return undefined;

    const source = args[2];
    if (!source) {
        console.error(`pizza config ${sub}: missing <source>. Usage: pizza config ${sub} <source> [serviceId...]`);
        return 1;
    }

    const found = readOverlayFor(cwd, agentDir, source, "user");
    if (!found || !found.result.overlay) {
        console.error(`pizza config ${sub}: no valid pi.pizzapi overlay found for "${source}" (must be a configured user-scope package).`);
        return 1;
    }
    const { provenance, result } = found;
    const declared = result.overlay!.services?.map((s) => s.id) ?? [];
    if (declared.length === 0) {
        console.error(`pizza config ${sub}: ${provenance.identity} declares no runner services.`);
        return 1;
    }

    const requestedIds = args.slice(3).filter((a) => !a.startsWith("-"));
    const ids = requestedIds.length > 0 ? requestedIds : declared;
    const unknown = ids.filter((id) => !declared.includes(id));
    if (unknown.length > 0) {
        console.error(`pizza config ${sub}: unknown service id(s) [${unknown.join(", ")}] for ${provenance.identity}. Declared: [${declared.join(", ")}]`);
        return 1;
    }

    if (sub === "grant") {
        grantServices(provenance.identity, ids);
        console.log(`${c.success("✓")} Granted [${ids.join(", ")}] for ${c.cmd(provenance.identity)}. ${describeRunningDaemon()}`);
    } else {
        revokeServices(provenance.identity, ids);
        console.log(`${c.success("✓")} Revoked [${ids.join(", ")}] for ${c.cmd(provenance.identity)}. ${describeRunningDaemon()}`);
    }
    return 0;
}

export interface OverlaySnapshotEntry {
    identity: string;
    source: string;
    overlayPresent: boolean;
    overlayValid: boolean;
    serviceIds: string[];
}

/**
 * Snapshot each configured user-scope package's declared overlay service ids
 * (plus overlay validity), keyed by normalized identity.
 *
 * P2: `pizza update` doesn't change `packages[]` in settings.json (the
 * identity is unchanged before/after), so a literal settings diff can't
 * detect that an update changed a package's *content*. We snapshot the
 * overlay content itself before and after the upstream update instead, so
 * `handlePostUpdateOverlay()` can diff declared service ids and catch a
 * newly-malformed overlay.
 */
export function snapshotOverlayServiceIds(cwd: string, agentDir: string): Map<string, OverlaySnapshotEntry> {
    const pm = packageManagerFor(cwd, agentDir);
    const configured = pm.listConfiguredPackages().filter((p) => p.scope === "user");
    const deduped = dedupeConfiguredPackages(configured, cwd, agentDir);
    const snapshot = new Map<string, OverlaySnapshotEntry>();
    for (const { identity, pkg } of deduped) {
        if (!pkg.installedPath) continue;
        const provenance: PackageProvenance = { identity, source: pkg.source, scope: "user" };
        const { overlay, present } = readOverlayManifest(pkg.installedPath, provenance);
        snapshot.set(identity, {
            identity,
            source: pkg.source,
            overlayPresent: present,
            overlayValid: present ? overlay !== null : true,
            serviceIds: overlay?.services?.map((s) => s.id) ?? [],
        });
    }
    return snapshot;
}

/**
 * Run after a successful upstream `pizza update`. Compares the pre-update
 * overlay snapshot (from `snapshotOverlayServiceIds`) against the current
 * one: a newly-malformed overlay fails the command (partial-update
 * remediation); newly-declared service ids are surfaced as untrusted but
 * never auto-granted; ids that were already granted stay granted (grants
 * are keyed by exact service id and untouched here). Returns the exit code
 * the CLI should use (0 unless an overlay became malformed).
 */
export function handlePostUpdateOverlay(cwd: string, agentDir: string, before: Map<string, OverlaySnapshotEntry>): number {
    const after = snapshotOverlayServiceIds(cwd, agentDir);
    let sawMalformed = false;
    const newlyDeclared: Array<{ identity: string; ids: string[] }> = [];

    for (const snap of after.values()) {
        if (snap.overlayPresent && !snap.overlayValid) {
            console.error(`\n${c.error("✗")} pi.pizzapi overlay is invalid for ${c.cmd(snap.identity)} after update:\n`);
            console.error(
                `  ${c.warning("Note:")} the pi-native package update may have completed (upstream update is not transactional); ` +
                `its daemon services remain unmounted. Run ${c.cmd(`pizza install ${snap.source}`)} to see full errors, or ${c.cmd(`pizza remove ${snap.source}`)} to undo.\n`,
            );
            sawMalformed = true;
            continue;
        }

        const prior = before.get(snap.identity);
        const priorIds = new Set(prior?.serviceIds ?? []);
        const granted = getGrantedServiceIds(snap.identity);
        const newUngranted = snap.serviceIds.filter((id) => !priorIds.has(id) && !granted.has(id));
        if (newUngranted.length > 0) {
            newlyDeclared.push({ identity: snap.identity, ids: newUngranted });
        }
    }

    for (const { identity, ids } of newlyDeclared) {
        console.log(
            `\n${c.warning("Note:")} ${c.cmd(identity)} now declares new runner service(s) [${ids.join(", ")}] — left ${c.warning("untrusted")}. ` +
            `Run ${c.cmd(`pizza config grant <source> ${ids.join(" ")}`)} to trust them.\n`,
        );
    }

    return sawMalformed ? 1 : 0;
}
