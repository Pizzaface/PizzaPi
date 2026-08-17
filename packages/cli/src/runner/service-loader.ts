/**
 * Runner service module loading.
 *
 * Runner services come from exactly one place: a **pi package** that declares
 * them under `pi.pizzapi.services` and has been granted daemon-service trust.
 * See `package-service-loader.ts` for discovery, and
 * `docs/customization/overlay-packages.mdx` for the manifest shape.
 *
 * This module holds only what that loader needs — the shared manifest types and
 * the module→ServiceHandler coercion.
 *
 * The legacy discovery modes are gone: scanning `~/.pizzapi/services/` and
 * `<cwd>/.pizzapi/services/` for loose files, and scanning plugin directories
 * for `manifest.json` / `package.json` service declarations. They installed
 * code onto the daemon with no trust grant and no provenance, which the overlay
 * spec (§12.4) replaces with an explicit per-package grant. Claude Code plugins
 * are still discovered for skills and agents — see `plugins/discover.ts` — they
 * just no longer contribute runner services.
 */
import type { ServiceHandler } from "./service-handler.js";
import type { ServiceModeDef, ServicePanelPlacement, ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Normalized description of a service, derived from a package's overlay declaration. */
export interface ServiceManifest {
    id: string;
    label: string;
    icon: string;
    entry?: string;
    panel?: {
        dir?: string;
        /** Variable names the panel requires. UI resolves and passes as query params. */
        requires?: string[];
        /** Declarative dock zone the host places this panel in by default. */
        placement?: ServicePanelPlacement;
        /** Open the panel automatically in its mode(s) instead of on click. */
        defaultOpen?: boolean;
    };
    /**
     * Whether this service has a UI panel shown to users. Set explicitly so a
     * trigger/sigil-only service (no `panel`) reliably gets
     * `announceSigilServer` at init time instead of `announcePanel`.
     */
    hasPanel?: boolean;
    /** Trigger types this service can emit. */
    triggers?: ServiceTriggerDef[];
    /** Sigil types this service defines. */
    sigils?: ServiceSigilDef[];
    sessionModes?: ServiceModeDef[];
    /**
     * Session mode ids this service's surfaces (panel, triggers) are scoped
     * to. Absent/empty = visible everywhere.
     */
    modes?: string[];
}

export interface ServicePluginResult {
    handler: ServiceHandler;
    source: ServicePluginSource;
    manifest?: ServiceManifest;
}

export interface ServicePluginSource {
    /**
     * Where this service came from. Only packages can supply services now; the
     * field is kept so log lines and diagnostics stay explicit about it.
     */
    origin: "package";
    /** Absolute path to the service entry module */
    path: string;
    /** Normalized package identity (e.g. "local:/path/to/pkg") */
    pluginName?: string;
}

export interface ServiceLoadError {
    path: string;
    error: string;
}

// ── Module loading ────────────────────────────────────────────────────────────

/**
 * Load a module and extract a ServiceHandler from it.
 *
 * Supports:
 * - Default export is an object with { id, init, dispose } (instance)
 * - Default export is a class with prototype { init, dispose } (needs new)
 * - Default export is a function that returns a ServiceHandler (factory)
 */
export async function loadServiceModule(filePath: string): Promise<ServiceHandler | null> {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;

    // Case 1: Already a ServiceHandler instance
    if (isServiceHandler(exported)) {
        return exported;
    }

    // Case 2: Constructor function / class
    if (typeof exported === "function") {
        try {
            const instance = new exported();
            if (isServiceHandler(instance)) {
                return instance;
            }
        } catch {
            // Not a constructor — try as factory
        }

        // Case 3: Factory function
        try {
            const result = await exported();
            if (isServiceHandler(result)) {
                return result;
            }
        } catch {
            // Not a valid factory
        }
    }

    return null;
}

function isServiceHandler(obj: unknown): obj is ServiceHandler {
    if (!obj || typeof obj !== "object") return false;
    const h = obj as Record<string, unknown>;
    return (
        typeof h.id === "string" &&
        typeof h.init === "function" &&
        typeof h.dispose === "function"
    );
}
