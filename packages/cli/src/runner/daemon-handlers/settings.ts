// Settings management socket.io handlers, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    sanitizeConfigForUI,
    restoreMaskedServerEntry,
    findRenamedServerMatch,
    validateProviderOverridesSection,
    mergeProviderOverridesSection,
} from "../daemon-config-sanitize.js";

export function registerSettingsHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    // ── Settings ───────────────────────────────────────────────────────

    // sanitizeConfigForUI is imported from ./daemon-config-sanitize.js

    socket.on("settings_get_config", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        try {
            const { loadGlobalConfig: loadGlobal } = await import("../../config.js");
            const globalConfig = loadGlobal();

            // Also read settings.json (TUI preferences)
            const settingsPath = join(homedir(), ".pizzapi", "settings.json");
            let tuiSettings: Record<string, unknown> = {};
            try {
                const { readFileSync, existsSync } = await import("fs");
                if (existsSync(settingsPath)) {
                    tuiSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
                }
            } catch {
                // settings.json may not exist yet
            }

            // Also read ~/.pizzapi/AGENTS.md
            const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
            let agentsMd = "";
            try {
                const { readFileSync, existsSync } = await import("fs");
                if (existsSync(agentsMdPath)) {
                    agentsMd = readFileSync(agentsMdPath, "utf-8");
                }
            } catch {
                // AGENTS.md may not exist yet
            }

            // Strip sensitive fields before sending to UI
            const sanitizedConfig = sanitizeConfigForUI(globalConfig as Record<string, unknown>);
            socket.emit("file_result", {
                requestId,
                ok: true,
                config: sanitizedConfig,
                tuiSettings,
                agentsMd,
            });
        } catch (err) {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("settings_update_section", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        const section = data?.section;
        const value = data?.value;
        try {
            if (!section || typeof section !== "string") {
                socket.emit("file_result", { requestId, ok: false, message: "Missing section name" });
                return;
            }

            // Handle AGENTS.md separately — it's a standalone file, not JSON config
            if (section === "agentsMd") {
                const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
                const { writeFileSync, chmodSync: chmodSyncAgents, mkdirSync, existsSync } = await import("fs");
                const dir = join(homedir(), ".pizzapi");
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
                const content = typeof value === "string" ? value : "";
                writeFileSync(agentsMdPath, content, { encoding: "utf-8", mode: 0o600 });
                chmodSyncAgents(agentsMdPath, 0o600); // tighten permissions on pre-existing files
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    saved: true,
                    message: "AGENTS.md saved. Changes apply on next session start.",
                });
                return;
            }

            // Sections that go into settings.json (TUI preferences)
            const tuiSections = new Set(["tuiPreferences", "models"]);

            if (tuiSections.has(section)) {
                // Read/merge/write settings.json
                const settingsPath = join(homedir(), ".pizzapi", "settings.json");
                const { readFileSync, writeFileSync, chmodSync: chmodSyncSettings, existsSync, mkdirSync } = await import("fs");
                const dir = join(homedir(), ".pizzapi");
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
                let existing: Record<string, unknown> = {};
                try {
                    if (existsSync(settingsPath)) {
                        existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
                    }
                } catch { /* start fresh */ }

                // Merge TUI settings at top level
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    Object.assign(existing, value);
                }
                writeFileSync(settingsPath, JSON.stringify(existing, null, 2), { encoding: "utf-8", mode: 0o600 });
                chmodSyncSettings(settingsPath, 0o600); // tighten permissions on pre-existing files
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    saved: true,
                    message: "TUI settings saved. Changes apply on next session start.",
                });
            } else {
                // All other sections go into config.json
                const { saveGlobalConfig: saveGlobal, loadGlobalConfig: loadGlobal } = await import("../../config.js");

                // Map section names to config.json keys
                const sectionToConfigKey: Record<string, string> = {
                    mcpServers: "mcpServers",
                    hooks: "hooks",
                    sandbox: "sandbox",
                    webSearch: "providerSettings",
                    toolSearch: "toolSearch",
                    security: "_security",        // virtual — handled specially
                    envVars: "_envVars",          // virtual — handled specially
                    systemPrompt: "_systemPrompt", // virtual — handled specially
                };

                const configKey = sectionToConfigKey[section] ?? section;
                const existing = loadGlobal();

                if (section === "security") {
                    const v = value as any;
                    const updates: Record<string, any> = {};
                    if (v?.allowProjectHooks !== undefined) updates.allowProjectHooks = v.allowProjectHooks;
                    if (v?.trustedPlugins !== undefined) updates.trustedPlugins = v.trustedPlugins;
                    saveGlobal(updates);
                } else if (section === "systemPrompt") {
                    const v = value as any;
                    const updates: Record<string, any> = {};
                    if (v?.appendSystemPrompt !== undefined) updates.appendSystemPrompt = v.appendSystemPrompt;
                    if (v?.builtinSystemPrompt !== undefined) updates.builtinSystemPrompt = v.builtinSystemPrompt;
                    if (v?.sendAgentsMd !== undefined) updates.sendAgentsMd = v.sendAgentsMd;
                    if (v?.skills !== undefined) updates.skills = v.skills;
                    saveGlobal(updates);
                } else if (section === "envVars") {
                    // Env vars are stored in a custom key in config.json.
                    // Restore any masked ("***") sentinel values from the on-disk config
                    // so we don't overwrite real secrets with the placeholder.
                    const MASK_SENTINEL = "***";
                    const existingOverrides = ((existing as any).envOverrides ?? {}) as Record<string, string>;
                    const incomingOverrides = (value ?? {}) as Record<string, string>;
                    const restoredOverrides: Record<string, string> = { ...incomingOverrides };
                    for (const [k, v] of Object.entries(incomingOverrides)) {
                        if (v === MASK_SENTINEL && typeof existingOverrides[k] === "string") {
                            restoredOverrides[k] = existingOverrides[k];
                        }
                    }
                    const updates: Record<string, any> = { envOverrides: restoredOverrides };
                    saveGlobal(updates);
                } else if (section === "providerOverrides") {
                    // Per-provider overrides (system prompt, AGENTS.md, MCP disable
                    // list) go into providerSettings.<provider>.overrides.
                    const validationErrors = validateProviderOverridesSection(value);
                    if (validationErrors.length > 0) {
                        socket.emit("file_result", {
                            requestId,
                            ok: false,
                            message: `Invalid provider overrides:\n${validationErrors.join("\n")}`,
                        });
                        return;
                    }
                    const ps = mergeProviderOverridesSection(
                        (existing as any).providerSettings,
                        (value ?? {}) as Record<string, unknown>,
                    );
                    saveGlobal({ providerSettings: ps } as any);
                } else if (section === "webSearch") {
                    // Web search config goes into providerSettings
                    const v = value as any;
                    const ps = (existing as any).providerSettings ?? {};
                    if (v?.anthropic?.webSearch) {
                        ps.anthropic = { ...ps.anthropic, webSearch: v.anthropic.webSearch };
                    }
                    if (v?.["ollama-cloud"]?.webSearch) {
                        ps["ollama-cloud"] = { ...ps["ollama-cloud"], webSearch: v["ollama-cloud"].webSearch };
                    }
                    saveGlobal({ providerSettings: ps } as any);
                } else if (section === "toolSearch") {
                    if (value != null && (typeof value !== "object" || Array.isArray(value))) {
                        socket.emit("file_result", {
                            requestId,
                            ok: false,
                            message: "toolSearch must be a JSON object",
                        });
                        return;
                    }

                    const toolSearch = (value ?? {}) as Record<string, unknown>;
                    const errors: string[] = [];
                    const enabled = toolSearch.enabled;
                    const tokenThreshold = toolSearch.tokenThreshold;
                    const maxResults = toolSearch.maxResults;
                    const keepLoadedTools = toolSearch.keepLoadedTools;

                    if (enabled !== undefined && typeof enabled !== "boolean") {
                        errors.push('"enabled" must be a boolean');
                    }
                    if (
                        tokenThreshold !== undefined &&
                        (typeof tokenThreshold !== "number" || !Number.isFinite(tokenThreshold) || tokenThreshold < 0)
                    ) {
                        errors.push('"tokenThreshold" must be a finite number >= 0');
                    }
                    if (
                        maxResults !== undefined &&
                        (typeof maxResults !== "number" || !Number.isFinite(maxResults) || maxResults < 1)
                    ) {
                        errors.push('"maxResults" must be a finite number >= 1');
                    }
                    if (keepLoadedTools !== undefined && typeof keepLoadedTools !== "boolean") {
                        errors.push('"keepLoadedTools" must be a boolean');
                    }
                    if (errors.length > 0) {
                        socket.emit("file_result", {
                            requestId,
                            ok: false,
                            message: `Invalid Tool Search config:\n${errors.join("\n")}`,
                        });
                        return;
                    }

                    saveGlobal({ toolSearch: value as any });
                } else if (section === "mcpServers") {
                    // Validate MCP server config before saving
                    if (value != null && (typeof value !== "object" || Array.isArray(value))) {
                        socket.emit("file_result", {
                            requestId,
                            ok: false,
                            message: "mcpServers must be a JSON object (Record<string, ServerEntry>)",
                        });
                        return;
                    }
                    const servers = (value ?? {}) as Record<string, any>;
                    const errors: string[] = [];
                    for (const [name, entry] of Object.entries(servers)) {
                        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
                            errors.push(`"${name}": must be an object`);
                            continue;
                        }
                        const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
                        const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
                        if (!hasCommand && !hasUrl) {
                            errors.push(`"${name}": must have a "command" (stdio) or "url" (http) field`);
                        }
                    }
                    if (errors.length > 0) {
                        socket.emit("file_result", {
                            requestId,
                            ok: false,
                            message: `Invalid MCP server config:\n${errors.join("\n")}`,
                        });
                        return;
                    }

                    // The settings API masks sensitive env var and header values (e.g. tokens/keys)
                    // with MASK_SENTINEL ("***") before sending them to the UI so they aren't
                    // exposed in transit.  When the UI sends the config back on save, those
                    // masked values must NOT be written to disk — restoreMaskedServerEntry()
                    // substitutes the original on-disk secret for each key still carrying the
                    // sentinel.
                    //
                    // Renames are handled heuristically by findRenamedServerMatch() below:
                    // when an incoming entry has masked secrets but no on-disk entry under its
                    // name, we look for a deleted entry whose env/header keys would supply the
                    // sentinels.  This survives the user editing command/url/args in the same
                    // save.  Truly ambiguous cases (multiple plausible renames) still fall back
                    // to writing the sentinel — visible and recoverable.
                    const existingMcpServers = ((existing as any).mcpServers ?? {}) as Record<string, any>;

                    // Identify deleted servers to heuristically match renames
                    const incomingNames = new Set(Object.keys(servers));
                    const deletedServers = Object.entries(existingMcpServers)
                        .filter(([name]) => !incomingNames.has(name))
                        .map(([_name, srv]) => srv)
                        .filter((srv) => srv && typeof srv === "object");

                    const mergedServers: Record<string, any> = {};
                    for (const [name, entry] of Object.entries(servers)) {
                        if (entry && typeof entry === "object") {
                            let existingEntry = existingMcpServers[name];
                            if (!existingEntry) {
                                existingEntry = findRenamedServerMatch(entry as Record<string, unknown>, deletedServers);
                            }

                            mergedServers[name] = restoreMaskedServerEntry(
                                entry as Record<string, unknown>,
                                existingEntry,
                            );
                        } else {
                            mergedServers[name] = entry;
                        }
                    }
                    saveGlobal({ mcpServers: mergedServers } as any);
                } else if (section === "mcp") {
                    // mcp.servers[] (preferred array format) — restore masked sentinel values
                    // before writing to disk.  We look up each server by its `name` field in
                    // the on-disk array so we can restore the original secret.
                    //
                    // Renames in the array format are likewise resolved via
                    // findRenamedServerMatch() against deleted entries.
                    const incomingMcp = (value ?? {}) as { servers?: any[] };
                    const existingMcp = ((existing as any).mcp ?? {}) as { servers?: any[] };

                    // Build name → entry map for O(1) lookup against the on-disk array.
                    const existingByName = new Map<string, Record<string, unknown>>();
                    if (Array.isArray(existingMcp.servers)) {
                        for (const s of existingMcp.servers) {
                            if (s && typeof s === "object" && typeof (s as any).name === "string") {
                                existingByName.set((s as any).name as string, s as Record<string, unknown>);
                            }
                        }
                    }

                    // Identify deleted servers to heuristically match renames
                    const incomingNamesArray = new Set(
                        Array.isArray(incomingMcp.servers)
                            ? incomingMcp.servers
                                  .map((s: any) => s && typeof s === "object" ? s.name : undefined)
                                  .filter((n): n is string => typeof n === "string")
                            : []
                    );

                    const deletedServersArray: Record<string, unknown>[] = [];
                    if (Array.isArray(existingMcp.servers)) {
                        for (const srv of existingMcp.servers) {
                            if (srv && typeof srv === "object" && typeof (srv as any).name === "string") {
                                if (!incomingNamesArray.has((srv as any).name)) {
                                    deletedServersArray.push(srv as Record<string, unknown>);
                                }
                            }
                        }
                    }

                    const mergedMcpServers: any[] = Array.isArray(incomingMcp.servers)
                        ? incomingMcp.servers.map((entry: any) => {
                              if (!entry || typeof entry !== "object") return entry;

                              let existingEntry: Record<string, unknown> | undefined = undefined;
                              if (typeof entry.name === "string") {
                                  existingEntry = existingByName.get(entry.name);
                                  if (!existingEntry) {
                                      existingEntry = findRenamedServerMatch(entry as Record<string, unknown>, deletedServersArray);
                                  }
                              }

                              return restoreMaskedServerEntry(
                                  entry as Record<string, unknown>,
                                  existingEntry,
                              );
                          })
                        : [];

                    saveGlobal({ mcp: { ...incomingMcp, servers: mergedMcpServers } } as any);
                } else {
                    // Direct key mapping
                    saveGlobal({ [configKey]: value } as any);
                }

                // Reload and return the updated config — mask secrets before sending to browser
                const updatedConfig = sanitizeConfigForUI(loadGlobal() as Record<string, unknown>);
                const isMcpSection = section === "mcpServers" || section === "mcp" || section === "toolSearch";
                const reloadHint = isMcpSection
                    ? "MCP server config saved. Active sessions can run /mcp reload to pick up changes."
                    : "Settings saved. Changes apply on next session start.";
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    saved: true,
                    config: updatedConfig,
                    message: reloadHint,
                    reloadHint: isMcpSection,
                });
            }
        } catch (err) {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
