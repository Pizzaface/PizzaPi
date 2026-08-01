/**
 * Feeds `pi.pizzapi.mcp` overlay sidecars — and the legacy Claude-plugin
 * `.mcp.json` file that was previously detected-but-ignored (`hasMcp` was a
 * boolean only) — into the existing MCP registry (mcp-extension.ts /
 * mcp/registry.ts). No second MCP runtime: this module only *augments* the
 * `PizzaPiConfig & McpConfig` object that already flows into
 * `registerMcpTools()`.
 *
 * Precedence (docs/specs/pi-pizzapi-overlay.md §4.3):
 *   1. Explicit PizzaPi config (`~/.pizzapi/config.json` / project
 *      `.pizzapi/config.json`) always wins a server-name collision — never
 *      overridden here.
 *   2. Between packages: project scope wins user scope, then settings
 *      order (first configured wins).
 *   3. Legacy global Claude-plugin `.mcp.json` servers fill in only names
 *      nothing else has claimed — package-over-legacy, matching the same
 *      precedence theme used for runner services (§8).
 * `disabledMcpServers` is untouched here — it already applies by name in
 * the existing registry regardless of where a server definition came from.
 *
 * `serverProvenance` on the result carries, for every overlay/legacy server
 * that won a name, WHERE it came from (package identity / legacy plugin,
 * scope, source path). mcp-extension.ts's `inspectMcpConfig()` folds this
 * into the same `effectiveServers` list its `/mcp` status and
 * disable/enable tab-completion already read — without it, an overlay- or
 * legacy-plugin-origin server is registered and running but invisible to
 * `/mcp` and can never be targeted by `/mcp disable <name>` completion.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@pizzapi/tools";
import type { PizzaPiConfig } from "../config.js";
import type { McpConfig } from "./mcp.js";
import { resolveSessionOverlays } from "../overlay/session-packages.js";
import { OVERLAY_SIDECAR_MAX_BYTES, resolveConfinedPath } from "../overlay/manifest.js";
import { discoverPlugins } from "../plugins.js";

const log = createLogger("mcp-overlay");

type Owner = "config" | "user" | "project" | "legacy";

export type McpServerOwner = Exclude<Owner, "config">;

export interface OverlayMcpServerProvenance {
    name: string;
    owner: McpServerOwner;
    /** Package identity (e.g. "npm:@acme/pkg") or "plugin:<name>" for legacy plugins. */
    identity: string;
    /** Package install root or legacy plugin root — display-only. */
    sourcePath: string;
    transport: string;
}

export interface MergeOverlayMcpServersResult {
    config: PizzaPiConfig & McpConfig;
    /** Provenance for every name whose winning definition came from an overlay/legacy source (not explicit PizzaPi config). */
    serverProvenance: OverlayMcpServerProvenance[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read+parse a JSON file with the same size cap overlay sidecars use. Returns undefined on any failure. */
function readJsonCapped(path: string): unknown | undefined {
    try {
        if (statSync(path).size > OVERLAY_SIDECAR_MAX_BYTES) return undefined;
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return undefined;
    }
}

/**
 * Revalidate a re-parsed mcp sidecar's top-level shape at mount time —
 * `readOverlayManifest()` only validates the `pi.pizzapi` manifest
 * (confirming `mcp` points at a confined, allowed path); it never opens the
 * sidecar file itself. Between manifest validation and this mount-time
 * read, the file could have been replaced with something that parses as
 * valid JSON but isn't a `{mcp:{servers:[...]}}`/`{mcpServers:{...}}`
 * object (e.g. a JSON array or scalar) — that must be skipped with a
 * warning, not silently treated as "declares zero servers".
 */
function isValidMcpSidecarShape(parsed: unknown): parsed is Record<string, unknown> {
    if (!isRecord(parsed)) return false;
    if ("mcp" in parsed && parsed.mcp !== undefined && !isRecord(parsed.mcp)) return false;
    if (isRecord(parsed.mcp) && "servers" in parsed.mcp && parsed.mcp.servers !== undefined && !Array.isArray(parsed.mcp.servers)) return false;
    if ("mcpServers" in parsed && parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) return false;
    return true;
}

/** Extract `{ preferred, compat }` server entries from a parsed mcp sidecar/`.mcp.json` value. */
function extractServers(parsed: unknown): { preferred: Record<string, unknown>[]; compat: Record<string, Record<string, unknown>> } {
    const preferred: Record<string, unknown>[] = [];
    const compat: Record<string, Record<string, unknown>> = {};
    if (!isRecord(parsed)) return { preferred, compat };
    const mcpServers = isRecord(parsed.mcp) ? (parsed.mcp as Record<string, unknown>).servers : undefined;
    if (Array.isArray(mcpServers)) {
        for (const s of mcpServers) if (isRecord(s) && typeof s.name === "string") preferred.push(s);
    }
    if (isRecord(parsed.mcpServers)) {
        for (const [name, val] of Object.entries(parsed.mcpServers)) {
            if (isRecord(val)) compat[name] = val;
        }
    }
    return { preferred, compat };
}

/**
 * Infer a display transport for a `mcpServers.<name>` compatibility-format
 * entry — shared with mcp-extension.ts's `parseConfigFile()` so `/mcp`
 * status shows the same transport label regardless of whether a server came
 * from an explicit config file or an overlay/legacy sidecar.
 */
export function inferMcpCompatTransport(value: Record<string, unknown>): string {
    if (typeof value.command === "string") return "stdio";
    if (typeof value.url === "string") {
        // "transport" is our field; "type" is Claude Code / VS Code format.
        // In the standard MCP ecosystem, type "http" = streamable HTTP.
        if (typeof value.transport === "string") return value.transport;
        if (value.type === "http") return "streamable";
        if (typeof value.type === "string") return value.type;
        return "http";
    }
    return "unknown";
}

export function mergeOverlayMcpServers(
    base: PizzaPiConfig & McpConfig,
    cwd: string,
    agentDir: string,
    projectTrusted: boolean,
): MergeOverlayMcpServersResult {
    const owner = new Map<string, Owner>();
    const preferredByName = new Map<string, Record<string, unknown>>();
    const compatByName = new Map<string, Record<string, unknown>>();
    const provenanceByName = new Map<string, OverlayMcpServerProvenance>();

    // Seed with explicit PizzaPi config — never overridden below, never
    // given overlay provenance (it's already visible via McpConfigFileState).
    for (const s of Array.isArray(base.mcp?.servers) ? (base.mcp!.servers as unknown[]) : []) {
        if (isRecord(s) && typeof s.name === "string") {
            owner.set(s.name, "config");
            preferredByName.set(s.name, s);
        }
    }
    for (const [name, val] of Object.entries(base.mcpServers ?? {})) {
        owner.set(name, "config");
        compatByName.set(name, val as Record<string, unknown>);
    }

    function addPass(
        scope: McpServerOwner,
        identity: string,
        sourcePath: string,
        preferred: Record<string, unknown>[],
        compat: Record<string, Record<string, unknown>>,
    ): void {
        for (const s of preferred) {
            const name = s.name as string;
            const existing = owner.get(name);
            const canSet = existing === undefined || (scope === "project" && existing === "user");
            if (!canSet) {
                log.warn(`[${identity}] mcp server "${name}" ignored — already defined by ${existing}`);
                continue;
            }
            owner.set(name, scope);
            preferredByName.set(name, s);
            compatByName.delete(name);
            provenanceByName.set(name, {
                name,
                owner: scope,
                identity,
                sourcePath,
                transport: typeof s.transport === "string" ? s.transport : "unknown",
            });
        }
        for (const [name, val] of Object.entries(compat)) {
            const existing = owner.get(name);
            const canSet = existing === undefined || (scope === "project" && existing === "user");
            if (!canSet) {
                log.warn(`[${identity}] mcp server "${name}" ignored — already defined by ${existing}`);
                continue;
            }
            owner.set(name, scope);
            compatByName.set(name, val);
            preferredByName.delete(name);
            provenanceByName.set(name, { name, owner: scope, identity, sourcePath, transport: inferMcpCompatTransport(val) });
        }
    }

    // ── Package overlays: user pass, then project pass (project overrides user) ──
    const { packages } = resolveSessionOverlays(cwd, agentDir, projectTrusted);
    for (const scope of ["user", "project"] as const) {
        for (const pkg of packages.filter((p) => p.scope === scope)) {
            if (!pkg.overlay.mcp) continue;
            const resolved = resolveConfinedPath(pkg.installedPath, pkg.overlay.mcp);
            if (!resolved.ok) {
                log.warn(`[${pkg.identity}] mcp sidecar failed re-validation: ${resolved.message}`);
                continue;
            }
            const parsed = readJsonCapped(resolved.absolutePath);
            if (parsed === undefined) {
                log.warn(`[${pkg.identity}] mcp sidecar could not be read/parsed at mount time`);
                continue;
            }
            if (!isValidMcpSidecarShape(parsed)) {
                log.warn(`[${pkg.identity}] mcp sidecar has an invalid shape at mount time (expected {mcp:{servers:[...]}} and/or {mcpServers:{...}}) — skipped`);
                continue;
            }
            const { preferred, compat } = extractServers(parsed);
            addPass(scope, pkg.identity, pkg.installedPath, preferred, compat);
        }
    }

    // ── Legacy: global (auto-trusted) Claude-plugin .mcp.json — lowest precedence ──
    for (const plugin of discoverPlugins(cwd)) {
        if (!plugin.hasMcp) continue;
        const mcpPath = join(plugin.rootPath, ".mcp.json");
        if (!existsSync(mcpPath)) continue;
        const parsed = readJsonCapped(mcpPath);
        if (parsed === undefined) {
            log.warn(`[plugin:${plugin.name}] .mcp.json could not be read/parsed at mount time`);
            continue;
        }
        if (!isValidMcpSidecarShape(parsed)) {
            log.warn(`[plugin:${plugin.name}] .mcp.json has an invalid shape at mount time (expected {mcp:{servers:[...]}} and/or {mcpServers:{...}}) — skipped`);
            continue;
        }
        const { preferred, compat } = extractServers(parsed);
        addPass("legacy", `plugin:${plugin.name}`, plugin.rootPath, preferred, compat);
    }

    const mergedPreferred = [...preferredByName.values()];
    const mergedCompat = Object.fromEntries(compatByName.entries());

    const config: PizzaPiConfig & McpConfig = {
        ...base,
        ...(mergedPreferred.length > 0 ? { mcp: { ...base.mcp, servers: mergedPreferred as never } } : { mcp: base.mcp }),
        ...(Object.keys(mergedCompat).length > 0 ? { mcpServers: mergedCompat as never } : { mcpServers: base.mcpServers }),
    };

    // Only names still owned by an overlay/legacy source at the end (never
    // shadowed by config or a higher-precedence pass) get provenance —
    // mirrors `owner`'s final state exactly since both maps are updated
    // together in addPass().
    const serverProvenance = [...provenanceByName.values()].filter((p) => owner.get(p.name) === p.owner);

    return { config, serverProvenance };
}
