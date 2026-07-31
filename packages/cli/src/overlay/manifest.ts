/**
 * Shared `pi.pizzapi` overlay manifest reader and strict schema-v1 validator.
 *
 * This is the single source of truth for overlay parsing — package commands
 * (install/list/config trust UX), daemon service discovery, and session-side
 * agents/rules/MCP loading all read overlays through this module so the
 * closed-schema and path-confinement rules never drift between call sites.
 *
 * Per docs/specs/pi-pizzapi-overlay.md §9.2: "Reading and validating
 * declarative JSON is allowed before the grant; importing the service entry
 * is not." This module never `import()`s or requires an `entry` file — it
 * only checks that the path resolves, stays confined, and has an allowed
 * extension.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { PanelVariable, PizzaPiOverlayV1, PizzaPiServiceDeclaration } from "@pizzapi/extension-sdk";
import { MAX_PLUGIN_FILE_SIZE } from "../plugins/types.js";

/** Reuse the existing 2 MiB per-file cap already used for plugin sidecar files. */
export const OVERLAY_SIDECAR_MAX_BYTES = MAX_PLUGIN_FILE_SIZE;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "services", "agents", "rules", "mcp"]);
const SERVICE_KEYS = new Set(["id", "label", "entry", "icon", "panel", "triggers", "sigils"]);
const PANEL_KEYS = new Set(["dir", "requires"]);
const PANEL_VARIABLES: ReadonlySet<PanelVariable> = new Set(["PWD", "SESSION_ID", "HOME", "USER", "PROJECT_DIR"]);
const SERVICE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ENTRY_EXTENSIONS = [".ts", ".js", ".mts", ".mjs"];
/** Value types allowed on a trigger param definition, mirrored from ServiceTriggerParamDef. */
const TRIGGER_PARAM_TYPES = new Set(["string", "number", "boolean", "json"]);
/** Allowed keys on a trigger param definition, mirrored from ServiceTriggerParamDef. */
const TRIGGER_PARAM_KEYS = new Set(["name", "label", "type", "description", "required", "default", "enum", "multiselect"]);
/** Allowed keys on a trigger definition, mirrored from ServiceTriggerDef. */
const TRIGGER_KEYS = new Set(["type", "label", "description", "schema", "params"]);
/** Allowed keys on a sigil definition, mirrored from ServiceSigilDef (excludes daemon-populated serviceId/resolvePort). */
const SIGIL_KEYS = new Set(["type", "label", "description", "icon", "resolve", "schema", "aliases", "variants"]);

export interface PackageProvenance {
    /** Normalized package identity, e.g. "npm:@acme/pi-github". */
    identity: string;
    /** Raw configured source string, e.g. "npm:@acme/pi-github@1.2.0". */
    source: string;
    scope: "user" | "project";
}

export interface OverlayIssue {
    identity: string;
    source: string;
    scope: "user" | "project";
    /** Dotted field path within the overlay, e.g. "services[0].panel.dir". */
    field: string;
    message: string;
    remediation: string;
}

export interface OverlayReadResult {
    /** The validated overlay, or null if absent or invalid. */
    overlay: PizzaPiOverlayV1 | null;
    /** True when `pi.pizzapi` was present at all (even if invalid). */
    present: boolean;
    issues: OverlayIssue[];
}

/** One-line provenance-rich rendering of an issue, per spec §11. */
export function formatOverlayIssue(issue: OverlayIssue): string {
    return `[${issue.identity} (${issue.scope}: ${issue.source})] ${issue.field}: ${issue.message} — ${issue.remediation}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve a package-relative path, rejecting absolute paths, `..` traversal,
 * and symlinks that resolve outside the package root.
 *
 * Returns the resolved absolute path on success, or an error message on
 * failure. Existence is the caller's responsibility (some callers need a
 * distinct "missing" message).
 */
export function resolveConfinedPath(
    packageRoot: string,
    relPath: string,
): { ok: true; absolutePath: string } | { ok: false; message: string } {
    if (typeof relPath !== "string" || relPath.length === 0) {
        return { ok: false, message: "path must be a non-empty string" };
    }
    if (isAbsolute(relPath)) {
        return { ok: false, message: `path "${relPath}" must be package-relative, not absolute` };
    }
    const segments = relPath.split(/[\\/]/);
    if (segments.some((seg) => seg === "..")) {
        return { ok: false, message: `path "${relPath}" must not contain ".." traversal segments` };
    }

    let realRoot: string;
    try {
        realRoot = realpathSync(packageRoot);
    } catch {
        return { ok: false, message: `package root "${packageRoot}" does not exist` };
    }

    const absolutePath = resolvePath(realRoot, relPath);
    if (absolutePath !== realRoot && !absolutePath.startsWith(realRoot + sep)) {
        return { ok: false, message: `path "${relPath}" escapes the package root` };
    }

    if (!existsSync(absolutePath)) {
        return { ok: false, message: `path "${relPath}" does not exist` };
    }

    // Symlink confinement: the fully resolved (real) path must also stay
    // inside the package root, even if the declared path itself was clean.
    let realTarget: string;
    try {
        realTarget = realpathSync(absolutePath);
    } catch {
        return { ok: false, message: `path "${relPath}" could not be resolved` };
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        return { ok: false, message: `path "${relPath}" resolves (via symlink) outside the package root` };
    }

    return { ok: true, absolutePath: realTarget };
}

function checkSidecarSize(absolutePath: string, relPath: string): string | null {
    try {
        const size = statSync(absolutePath).size;
        if (size > OVERLAY_SIDECAR_MAX_BYTES) {
            return `sidecar file "${relPath}" is ${size} bytes, exceeding the ${OVERLAY_SIDECAR_MAX_BYTES}-byte cap`;
        }
    } catch {
        return `sidecar file "${relPath}" could not be read`;
    }
    return null;
}

/**
 * Resolve, size-cap, and JSON-parse a sidecar file (mcp/triggers/sigils).
 * Requires a REGULAR `.json` file inside the package root — rejects
 * directories, non-`.json` extensions, oversized files, and content that
 * doesn't parse as JSON (malformed JSON, HTML, etc). Returns the parsed
 * value on success, or `undefined` after pushing an issue on failure.
 */
function readSidecarJson(packageRoot: string, relPath: string, field: string, push: PushFn): unknown | undefined {
    const resolved = resolveConfinedPath(packageRoot, relPath);
    if (!resolved.ok) {
        push(field, resolved.message, `Point ${field} at a valid JSON file inside the package root.`);
        return undefined;
    }
    if (!relPath.toLowerCase().endsWith(".json")) {
        push(field, `sidecar file "${relPath}" must have a .json extension`, `Point ${field} at a .json file.`);
        return undefined;
    }
    let isFile = false;
    try {
        isFile = statSync(resolved.absolutePath).isFile();
    } catch {
        isFile = false;
    }
    if (!isFile) {
        push(field, `sidecar path "${relPath}" must resolve to a regular file, not a directory`, `Point ${field} at a JSON file inside the package root.`);
        return undefined;
    }
    const sizeError = checkSidecarSize(resolved.absolutePath, relPath);
    if (sizeError) {
        push(field, sizeError, `Shrink the sidecar file below ${OVERLAY_SIDECAR_MAX_BYTES} bytes, or split it.`);
        return undefined;
    }
    let text: string;
    try {
        text = readFileSync(resolved.absolutePath, "utf-8");
    } catch {
        push(field, `sidecar file "${relPath}" could not be read`, `Point ${field} at a readable JSON file.`);
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        push(field, `sidecar file "${relPath}" is not valid JSON`, `Fix ${relPath} so it parses as JSON.`);
        return undefined;
    }
}

/** Read `package.json` and extract the raw (unvalidated) `pi.pizzapi` value, if present. */
function readRawOverlay(packageRoot: string): { raw: unknown; present: boolean; error?: string } {
    const pkgJsonPath = join(packageRoot, "package.json");
    if (!existsSync(pkgJsonPath)) {
        return { raw: undefined, present: false };
    }
    let stat;
    try {
        stat = lstatSync(pkgJsonPath);
    } catch {
        return { raw: undefined, present: false };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return { raw: undefined, present: false };
    }
    let text: string;
    try {
        text = readFileSync(pkgJsonPath, "utf-8");
    } catch {
        return { raw: undefined, present: false, error: "package.json could not be read" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { raw: undefined, present: false, error: "package.json is not valid JSON" };
    }
    if (!isPlainObject(parsed)) return { raw: undefined, present: false };
    const pi = parsed.pi;
    if (!isPlainObject(pi)) return { raw: undefined, present: false };
    if (!("pizzapi" in pi)) return { raw: undefined, present: false };
    return { raw: pi.pizzapi, present: true };
}

/**
 * Read and strictly validate a package's `pi.pizzapi` overlay.
 *
 * - Absent overlay (no `pi.pizzapi` key): `{ overlay: null, present: false, issues: [] }`.
 * - Malformed overlay: `{ overlay: null, present: true, issues: [...] }` — the
 *   whole overlay is rejected as a unit (no partial mount), matching §5.2.
 * - Never imports `entry` — only validates that it resolves to an allowed
 *   extension inside the package root.
 */
export function readOverlayManifest(packageRoot: string, provenance: PackageProvenance): OverlayReadResult {
    const { raw, present, error } = readRawOverlay(packageRoot);
    if (!present) {
        if (error) {
            return {
                overlay: null,
                present: false,
                issues: [issue(provenance, "package.json", error, "Fix package.json so it can be parsed.")],
            };
        }
        return { overlay: null, present: false, issues: [] };
    }

    const issues: OverlayIssue[] = [];
    const push = (field: string, message: string, remediation: string) => {
        issues.push(issue(provenance, field, message, remediation));
    };

    if (!isPlainObject(raw)) {
        push("pi.pizzapi", "must be an object", "Declare pi.pizzapi as a JSON object matching schema version 1.");
        return { overlay: null, present: true, issues };
    }

    for (const key of Object.keys(raw)) {
        if (!TOP_LEVEL_KEYS.has(key)) {
            push(key, `unknown top-level overlay key "${key}"`, `Remove "${key}" — schema v1 keys are: ${[...TOP_LEVEL_KEYS].join(", ")}.`);
        }
    }

    if (raw.schemaVersion !== 1) {
        const got = JSON.stringify(raw.schemaVersion);
        push(
            "schemaVersion",
            `must be exactly 1 (got ${got})`,
            "Set schemaVersion to 1, or update this package for the loader's supported schema version.",
        );
        // Unsupported/missing version invalidates the whole overlay — nothing
        // downstream is safe to interpret without knowing the schema.
        return { overlay: null, present: true, issues };
    }

    validateAgentsOrRules(raw.agents, "agents", packageRoot, push);
    validateAgentsOrRules(raw.rules, "rules", packageRoot, push);

    if (raw.mcp !== undefined) {
        if (typeof raw.mcp !== "string") {
            push("mcp", "must be a package-relative JSON path string", "Set mcp to a single package-relative path, e.g. \"./.mcp.json\".");
        } else {
            const parsed = readSidecarJson(packageRoot, raw.mcp, "mcp", push);
            if (parsed !== undefined) {
                validateMcpShape(parsed, "mcp", push);
            }
        }
    }

    const services = validateServices(raw.services, packageRoot, push);

    if (issues.length > 0) {
        return { overlay: null, present: true, issues };
    }

    const overlay: PizzaPiOverlayV1 = { schemaVersion: 1 };
    if (services) overlay.services = services;
    if (Array.isArray(raw.agents)) overlay.agents = raw.agents as string[];
    if (Array.isArray(raw.rules)) overlay.rules = raw.rules as string[];
    if (typeof raw.mcp === "string") overlay.mcp = raw.mcp;

    return { overlay, present: true, issues: [] };
}

function issue(provenance: PackageProvenance, field: string, message: string, remediation: string): OverlayIssue {
    return { identity: provenance.identity, source: provenance.source, scope: provenance.scope, field, message, remediation };
}

type PushFn = (field: string, message: string, remediation: string) => void;

/** Agent/rule entries must resolve to a directory, or a REGULAR `.md` file — never an arbitrary file. */
function validateAgentsOrRules(value: unknown, field: string, packageRoot: string, push: PushFn): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
        push(field, "must be an array of package-relative paths", `Set ${field} to an array of Markdown file/directory paths.`);
        return;
    }
    value.forEach((entry, i) => {
        const entryField = `${field}[${i}]`;
        if (typeof entry !== "string" || entry.length === 0) {
            push(entryField, "must be a non-empty string path", `Fix ${entryField} to a package-relative path.`);
            return;
        }
        const resolved = resolveConfinedPath(packageRoot, entry);
        if (!resolved.ok) {
            push(entryField, resolved.message, `Point ${entryField} at a valid path inside the package root.`);
            return;
        }
        let st;
        try {
            st = statSync(resolved.absolutePath);
        } catch {
            push(entryField, `path "${entry}" could not be read`, `Point ${entryField} at a directory or .md file inside the package root.`);
            return;
        }
        if (st.isDirectory()) return;
        if (st.isFile() && resolved.absolutePath.toLowerCase().endsWith(".md")) return;
        push(entryField, `must resolve to a directory or a .md file (got "${entry}")`, `Point ${entryField} at a directory or a Markdown (.md) file.`);
    });
}

/**
 * Shape-check a parsed `mcp` sidecar JSON value. Must contain at least one
 * of the two formats PizzaPi's MCP loader already accepts: the preferred
 * `mcp.servers` array or the compatibility `mcpServers` object (see
 * extensions/mcp-extension.ts, extensions/mcp/registry.ts). Entries are
 * shape-checked just enough to reject junk while staying compatible with
 * every transport variant those loaders already support.
 */
function validateMcpShape(parsed: unknown, field: string, push: PushFn): void {
    if (!isPlainObject(parsed)) {
        push(field, "sidecar JSON must be a top-level object", "The mcp sidecar file must contain a JSON object with mcp.servers or mcpServers.");
        return;
    }

    const mcpServersArray = isPlainObject(parsed.mcp) && Array.isArray((parsed.mcp as Record<string, unknown>).servers)
        ? ((parsed.mcp as Record<string, unknown>).servers as unknown[])
        : undefined;
    const mcpServersObject = isPlainObject(parsed.mcpServers) ? (parsed.mcpServers as Record<string, unknown>) : undefined;

    if (mcpServersArray === undefined && mcpServersObject === undefined) {
        push(field, "must contain mcp.servers (array) or mcpServers (object)", "Use the preferred { mcp: { servers: [...] } } or compatibility { mcpServers: {...} } format.");
        return;
    }

    if (mcpServersArray !== undefined) {
        mcpServersArray.forEach((entry, i) => {
            const entryField = `${field}.servers[${i}]`;
            if (!isPlainObject(entry)) {
                push(entryField, "must be an object", "Fix this mcp.servers entry to a { name, command|url } object.");
                return;
            }
            if (typeof entry.name !== "string" || entry.name.length === 0) {
                push(`${entryField}.name`, "must be a non-empty string", "Set name to a unique server identifier.");
            }
            if (typeof entry.command !== "string" && typeof entry.url !== "string") {
                push(entryField, "must have a string command (stdio) or url (http/streamable)", "Set command for a stdio server, or url for an http/streamable server.");
            }
        });
    }

    if (mcpServersObject !== undefined) {
        for (const [name, value] of Object.entries(mcpServersObject)) {
            const entryField = `${field}.mcpServers.${name}`;
            if (!isPlainObject(value)) {
                push(entryField, "must be an object", "Fix this mcpServers entry to a { command|url } object.");
                continue;
            }
            if (typeof value.command !== "string" && typeof value.url !== "string") {
                push(entryField, "must have a string command (stdio) or url (http/streamable)", "Set command for a stdio server, or url for an http/streamable server.");
            }
        }
    }
}

function validateTriggerParamDef(entry: unknown, field: string, push: PushFn): void {
    if (!isPlainObject(entry)) {
        push(field, "must be an object", `Fix ${field} to a trigger param definition object.`);
        return;
    }
    for (const key of Object.keys(entry)) {
        if (!TRIGGER_PARAM_KEYS.has(key)) {
            push(`${field}.${key}`, `unknown param key "${key}"`, `Remove "${key}" — allowed keys: ${[...TRIGGER_PARAM_KEYS].join(", ")}.`);
        }
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
        push(`${field}.name`, "must be a non-empty string", "Set name to the parameter's identifier.");
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
        push(`${field}.label`, "must be a non-empty string", "Set label to a human-readable name.");
    }
    if (typeof entry.type !== "string" || !TRIGGER_PARAM_TYPES.has(entry.type)) {
        push(`${field}.type`, `must be one of ${[...TRIGGER_PARAM_TYPES].join(", ")}`, `Set type to one of: ${[...TRIGGER_PARAM_TYPES].join(", ")}.`);
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
        push(`${field}.description`, "must be a string", "Set description to a string, or omit it.");
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
        push(`${field}.required`, "must be a boolean", "Set required to true/false, or omit it.");
    }
    let enumOk = true;
    if (entry.enum !== undefined) {
        enumOk = Array.isArray(entry.enum) && entry.enum.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
        if (!enumOk) {
            push(`${field}.enum`, "must be an array of strings/numbers/booleans", "Set enum to an array of allowed primitive values, or omit it.");
        }
    }
    if (entry.multiselect !== undefined) {
        if (typeof entry.multiselect !== "boolean") {
            push(`${field}.multiselect`, "must be a boolean", "Set multiselect to true/false, or omit it.");
        } else if (entry.multiselect && !(Array.isArray(entry.enum) && enumOk)) {
            push(`${field}.multiselect`, "requires enum to be set", "Add an enum array, or remove multiselect.");
        }
    }
    // `default` accepts any JsonValue — no further shape check needed.
}

function validateTriggerDef(entry: unknown, field: string, push: PushFn): void {
    if (!isPlainObject(entry)) {
        push(field, "must be an object", `Fix ${field} to a { type, label } trigger definition object.`);
        return;
    }
    for (const key of Object.keys(entry)) {
        if (!TRIGGER_KEYS.has(key)) {
            push(`${field}.${key}`, `unknown trigger key "${key}"`, `Remove "${key}" — allowed keys: ${[...TRIGGER_KEYS].join(", ")}.`);
        }
    }
    if (typeof entry.type !== "string" || entry.type.length === 0) {
        push(`${field}.type`, "must be a non-empty string", 'Set type to a namespaced trigger type, e.g. "myservice:event".');
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
        push(`${field}.label`, "must be a non-empty string", "Set label to a human-readable trigger name.");
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
        push(`${field}.description`, "must be a string", "Set description to a string, or omit it.");
    }
    if (entry.schema !== undefined && !isPlainObject(entry.schema)) {
        push(`${field}.schema`, "must be an object (JSON Schema)", "Set schema to a JSON Schema object, or omit it.");
    }
    if (entry.params !== undefined) {
        if (!Array.isArray(entry.params)) {
            push(`${field}.params`, "must be an array of trigger param definitions", "Set params to an array, or omit it.");
        } else {
            entry.params.forEach((p, i) => validateTriggerParamDef(p, `${field}.params[${i}]`, push));
        }
    }
}

function validateSigilDef(entry: unknown, field: string, push: PushFn): void {
    if (!isPlainObject(entry)) {
        push(field, "must be an object", `Fix ${field} to a { type, label } sigil definition object.`);
        return;
    }
    for (const key of Object.keys(entry)) {
        if (!SIGIL_KEYS.has(key)) {
            push(`${field}.${key}`, `unknown sigil key "${key}"`, `Remove "${key}" — allowed keys: ${[...SIGIL_KEYS].join(", ")}.`);
        }
    }
    if (typeof entry.type !== "string" || entry.type.length === 0) {
        push(`${field}.type`, "must be a non-empty string", 'Set type to a short sigil type name, e.g. "pr".');
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
        push(`${field}.label`, "must be a non-empty string", "Set label to a human-readable name.");
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
        push(`${field}.description`, "must be a string", "Set description to a string, or omit it.");
    }
    if (entry.icon !== undefined && typeof entry.icon !== "string") {
        push(`${field}.icon`, "must be a string", "Set icon to a Lucide icon name, or omit it.");
    }
    if (entry.resolve !== undefined && typeof entry.resolve !== "string") {
        push(`${field}.resolve`, "must be a string", "Set resolve to an endpoint path, or omit it.");
    }
    if (entry.schema !== undefined && !isPlainObject(entry.schema)) {
        push(`${field}.schema`, "must be an object (JSON Schema)", "Set schema to a JSON Schema object, or omit it.");
    }
    if (entry.aliases !== undefined) {
        if (!Array.isArray(entry.aliases) || !entry.aliases.every((v) => typeof v === "string")) {
            push(`${field}.aliases`, "must be an array of strings", "Set aliases to an array of alternate type names, or omit it.");
        }
    }
    if (entry.variants !== undefined) {
        if (!Array.isArray(entry.variants) || !entry.variants.every((v) => isPlainObject(v) && typeof v.name === "string" && typeof v.description === "string")) {
            push(`${field}.variants`, "must be an array of { name, description } objects", "Fix variants entries, or omit it.");
        }
    }
}

/**
 * Validate a service's `triggers`/`sigils` field: either a package-relative
 * JSON sidecar path (which must parse to an array) or an inline array. Every
 * resulting entry is shape-checked against the trigger/sigil protocol
 * declarations so junk (wrong types, missing type/label, malformed params)
 * is rejected rather than silently forwarded.
 */
/**
 * Validate a triggers/sigils field and return the fully resolved array of
 * definitions (whether declared inline or via a sidecar JSON path) so
 * callers never need to re-parse a sidecar file themselves. Returns
 * `undefined` on any validation failure — the caller already tracked the
 * issue via `push`.
 */
function validateTriggerOrSigilField(
    sidecarValue: unknown,
    field: string,
    packageRoot: string,
    kind: "triggers" | "sigils",
    push: PushFn,
): unknown[] | undefined {
    const validateEntry = kind === "triggers" ? validateTriggerDef : validateSigilDef;

    if (typeof sidecarValue === "string") {
        const parsed = readSidecarJson(packageRoot, sidecarValue, field, push);
        if (parsed === undefined) return undefined;
        if (!Array.isArray(parsed)) {
            push(field, "sidecar JSON must be an array of definitions", `Fix the ${kind} sidecar file to contain a top-level JSON array.`);
            return undefined;
        }
        parsed.forEach((entry, i) => validateEntry(entry, `${field}[${i}]`, push));
        return parsed;
    }

    if (Array.isArray(sidecarValue)) {
        sidecarValue.forEach((entry, i) => validateEntry(entry, `${field}[${i}]`, push));
        return sidecarValue;
    }

    push(field, "must be a package-relative JSON path or an inline array", `Set ${field} to a string path or an array.`);
    return undefined;
}

function validateServices(
    value: unknown,
    packageRoot: string,
    push: PushFn,
): PizzaPiServiceDeclaration[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        push("services", "must be an array of service declarations", "Set services to an array of { id, label, entry } objects.");
        return undefined;
    }

    const result: PizzaPiServiceDeclaration[] = [];
    const seenIds = new Set<string>();

    value.forEach((raw, i) => {
        const field = `services[${i}]`;
        if (!isPlainObject(raw)) {
            push(field, "must be an object", `Fix ${field} to a { id, label, entry } object.`);
            return;
        }
        for (const key of Object.keys(raw)) {
            if (!SERVICE_KEYS.has(key)) {
                push(`${field}.${key}`, `unknown service key "${key}"`, `Remove "${key}" — allowed keys: ${[...SERVICE_KEYS].join(", ")}.`);
            }
        }

        let valid = true;

        if (typeof raw.id !== "string" || !SERVICE_ID_RE.test(raw.id)) {
            push(`${field}.id`, `must match ${SERVICE_ID_RE.source}`, "Use a lowercase id starting with a letter, e.g. \"github\".");
            valid = false;
        } else if (seenIds.has(raw.id)) {
            push(`${field}.id`, `duplicate service id "${raw.id}" within this package`, "Give each service a unique id.");
            valid = false;
        } else {
            seenIds.add(raw.id);
        }

        if (typeof raw.label !== "string" || raw.label.length === 0) {
            push(`${field}.label`, "must be a non-empty string", "Set label to a short display name for the service.");
            valid = false;
        }

        if (typeof raw.entry !== "string" || raw.entry.length === 0) {
            push(`${field}.entry`, "must be a non-empty package-relative path", "Set entry to the service's implementation file.");
            valid = false;
        } else {
            const resolved = resolveConfinedPath(packageRoot, raw.entry);
            if (!resolved.ok) {
                push(`${field}.entry`, resolved.message, "Point entry at a file inside the package root.");
                valid = false;
            } else {
                const hasAllowedExt = ENTRY_EXTENSIONS.some((ext) => resolved.absolutePath.endsWith(ext));
                let isFile = false;
                try {
                    isFile = statSync(resolved.absolutePath).isFile();
                } catch {
                    isFile = false;
                }
                if (!hasAllowedExt || !isFile) {
                    push(`${field}.entry`, `must resolve to a file with extension ${ENTRY_EXTENSIONS.join("/")}`, "Point entry at a .ts/.js/.mts/.mjs file.");
                    valid = false;
                }
                // NOTE: entry is never imported/required here — only checked
                // for existence, type, and extension. See module docstring.
            }
        }

        if (raw.icon !== undefined && typeof raw.icon !== "string") {
            push(`${field}.icon`, "must be a string", "Set icon to a string identifier, or omit it.");
            valid = false;
        }

        if (raw.panel !== undefined) {
            if (!isPlainObject(raw.panel)) {
                push(`${field}.panel`, "must be an object", "Set panel to { dir, requires? }, or omit it.");
                valid = false;
            } else {
                for (const key of Object.keys(raw.panel)) {
                    if (!PANEL_KEYS.has(key)) {
                        push(`${field}.panel.${key}`, `unknown panel key "${key}"`, `Remove "${key}" — allowed keys: dir, requires.`);
                    }
                }
                if (typeof raw.panel.dir !== "string" || raw.panel.dir.length === 0) {
                    push(`${field}.panel.dir`, "must be a non-empty package-relative path", "Set panel.dir to the panel UI directory.");
                    valid = false;
                } else {
                    const resolved = resolveConfinedPath(packageRoot, raw.panel.dir);
                    if (!resolved.ok) {
                        push(`${field}.panel.dir`, resolved.message, "Point panel.dir at a directory inside the package root.");
                        valid = false;
                    } else {
                        let isDir = false;
                        try {
                            isDir = statSync(resolved.absolutePath).isDirectory();
                        } catch {
                            isDir = false;
                        }
                        if (!isDir) {
                            push(`${field}.panel.dir`, "must resolve to a directory", "Point panel.dir at a directory, not a file.");
                            valid = false;
                        }
                    }
                }
                if (raw.panel.requires !== undefined) {
                    if (!Array.isArray(raw.panel.requires) || !raw.panel.requires.every((v: unknown) => typeof v === "string" && PANEL_VARIABLES.has(v as PanelVariable))) {
                        push(
                            `${field}.panel.requires`,
                            "must be an array drawn from the five PanelVariable values",
                            `Use only: ${[...PANEL_VARIABLES].join(", ")}.`,
                        );
                        valid = false;
                    }
                }
            }
        }

        // Note: trigger/sigil shape issues push directly via `push`, which
        // rejects the whole overlay in readOverlayManifest regardless of the
        // `valid` flag below — no local bookkeeping needed here. The resolved
        // array (inline or sidecar-parsed) is written back onto `raw` so
        // downstream consumers (daemon package-service discovery) always see
        // a literal ServiceTriggerDef[]/ServiceSigilDef[], never a sidecar path.
        for (const sidecarField of ["triggers", "sigils"] as const) {
            const sidecarValue = raw[sidecarField];
            if (sidecarValue === undefined) continue;
            const resolved = validateTriggerOrSigilField(sidecarValue, `${field}.${sidecarField}`, packageRoot, sidecarField, push);
            if (resolved !== undefined) {
                (raw as Record<string, unknown>)[sidecarField] = resolved;
            }
        }

        if (valid) {
            result.push(raw as unknown as PizzaPiServiceDeclaration);
        }
    });

    return result;
}
