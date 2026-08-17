import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOverlayManifest, resolveConfinedPath, OVERLAY_SIDECAR_MAX_BYTES } from "./manifest.js";

const provenance = { identity: "local:/pkg", source: "./pkg", scope: "user" as const };

function fixturePkg(overlay: unknown, extra?: (dir: string) => void): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-overlay-")));
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", pi: { pizzapi: overlay } }),
    );
    writeFileSync(join(dir, "service.ts"), "export default {};");
    if (extra) extra(dir);
    return dir;
}

describe("readOverlayManifest", () => {
    let dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
        dirs = [];
    });

    test("absent pi.pizzapi: overlay null, present false, no issues", () => {
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-overlay-"));
        dirs.push(dir);
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
        const result = readOverlayManifest(dir, { ...provenance, identity: "local:x" });
        expect(result.overlay).toBeNull();
        expect(result.present).toBe(false);
        expect(result.issues).toHaveLength(0);
    });

    test("valid minimal overlay with a service", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.services?.[0]?.id).toBe("github");
    });

    test("unknown top-level key is rejected with all errors reported together", () => {
        const dir = fixturePkg({ schemaVersion: 1, bogus: true, providers: {} });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.present).toBe(true);
        const fields = result.issues.map((i) => i.field);
        expect(fields).toContain("bogus");
        expect(fields).toContain("providers");
    });

    test("unsupported schema version is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 2 });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues[0]?.field).toBe("schemaVersion");
    });

    test("duplicate service ids invalidate the overlay", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [
                { id: "github", label: "GitHub", entry: "./service.ts" },
                { id: "github", label: "GitHub 2", entry: "./service.ts" },
            ],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("duplicate service id"))).toBe(true);
    });

    test("invalid service id format is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "GitHub!", label: "x", entry: "./service.ts" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].id")).toBe(true);
    });

    test("absolute entry path is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "/etc/passwd" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("absolute"))).toBe(true);
    });

    test("traversal (..) entry path is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "../outside.ts" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes(".."))).toBe(true);
    });

    test("symlink escaping the package root is rejected", () => {
        const outsideDir = mkdtempSync(join(tmpdir(), "pizzapi-outside-"));
        dirs.push(outsideDir);
        writeFileSync(join(outsideDir, "evil.ts"), "export default {};");
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./link.ts" }] }, (d) => {
            symlinkSync(join(outsideDir, "evil.ts"), join(d, "link.ts"));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("symlink"))).toBe(true);
    });

    test("entry with disallowed extension is rejected without importing it", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.json" }] }, (d) => {
            writeFileSync(join(d, "service.json"), "{}");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].entry")).toBe(true);
    });

    test("missing sidecar (mcp path) is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./missing.json" });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("does not exist"))).toBe(true);
    });

    test("oversized sidecar (>2 MiB) is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./big.json" }, (d) => {
            writeFileSync(join(d, "big.json"), "x".repeat(OVERLAY_SIDECAR_MAX_BYTES + 1));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("exceeding"))).toBe(true);
    });

    test("panel.dir must resolve to a directory inside the package root", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./service.ts" } }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].panel.dir")).toBe(true);
    });

    test("panel.placement and defaultOpen are accepted and preserved on the overlay", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./panel", placement: "left-bottom", defaultOpen: true } }],
        }, (d) => { mkdirSync(join(d, "panel")); });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.services?.[0]?.panel?.placement).toBe("left-bottom");
        expect(result.overlay?.services?.[0]?.panel?.defaultOpen).toBe(true);
    });

    test("an unknown panel dock zone is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./panel", placement: "middle" } }],
        }, (d) => { mkdirSync(join(d, "panel")); });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].panel.placement")).toBe(true);
    });

    test("a non-boolean panel.defaultOpen is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./panel", defaultOpen: "yes" } }],
        }, (d) => { mkdirSync(join(d, "panel")); });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].panel.defaultOpen")).toBe(true);
    });

    test("panel.launcher is accepted and preserved on the overlay", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./panel", launcher: { surface: "session-list", position: "bottom-right" } } }],
        }, (d) => { mkdirSync(join(d, "panel")); });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.services?.[0]?.panel?.launcher).toEqual({ surface: "session-list", position: "bottom-right" });
    });

    test("panel.launcher with an unknown surface or position is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./panel", launcher: { surface: "unknown", position: "bottom-right" } } }],
        }, (d) => { mkdirSync(join(d, "panel")); });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].panel.launcher.surface")).toBe(true);
    });

    // ── mcp sidecar shape/format ────────────────────────────────────────────

    test("mcp sidecar with malformed JSON is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./bad.json" }, (d) => {
            writeFileSync(join(d, "bad.json"), "{ not valid json,,,");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("not valid JSON"))).toBe(true);
    });

    test("mcp sidecar containing HTML is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./bad.json" }, (d) => {
            writeFileSync(join(d, "bad.json"), "<html><body>nope</body></html>");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("not valid JSON"))).toBe(true);
    });

    test("mcp sidecar pointing at a directory is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./sidecar-dir.json" }, (d) => {
            mkdirSync(join(d, "sidecar-dir.json"));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("regular file"))).toBe(true);
    });

    test("mcp sidecar with non-.json extension is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./config.txt" }, (d) => {
            writeFileSync(join(d, "config.txt"), JSON.stringify({ mcpServers: { x: { command: "foo" } } }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes(".json extension"))).toBe(true);
    });

    test("mcp sidecar with invalid shape (neither mcp.servers nor mcpServers) is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./junk.json" }, (d) => {
            writeFileSync(join(d, "junk.json"), JSON.stringify({ foo: "bar" }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("mcp.servers"))).toBe(true);
    });

    test("preferred mcp.servers entry with command but no transport is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./bad-entry.json" }, (d) => {
            writeFileSync(join(d, "bad-entry.json"), JSON.stringify({ mcp: { servers: [{ name: "x", command: "echo" }] } }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues).toContainEqual(expect.objectContaining({ field: "mcp.servers[0].transport", message: expect.stringContaining("required") }));
    });

    test("preferred mcp.servers rejects every field outside its transport matrix", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./bad-entry.json" }, (d) => {
            writeFileSync(join(d, "bad-entry.json"), JSON.stringify({
                mcp: { servers: [
                    { name: "unknown", transport: "sse", url: "https://example.test/mcp", bogus: true },
                    { name: "stdio", transport: "stdio", command: "echo", url: "https://example.test/mcp", headers: {}, oauthClientName: "x", oauthClientId: "id", oauthClientSecret: "secret", oauthCallbackPort: 1, bogus: true },
                    { name: "http", transport: "http", url: "https://example.test/mcp", command: "echo", args: [], env: {}, cwd: ".", oauthClientName: "x", oauthClientId: "id", oauthClientSecret: "secret", oauthCallbackPort: 1, bogus: true },
                    { name: "streamable", transport: "streamable", url: "https://example.test/mcp", command: "echo", args: [], env: {}, cwd: ".", bogus: true },
                ] },
            }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.map((i) => i.field)).toEqual(expect.arrayContaining([
            "mcp.servers[0].transport", "mcp.servers[0].bogus",
            "mcp.servers[1].url", "mcp.servers[1].headers", "mcp.servers[1].oauthClientName", "mcp.servers[1].oauthClientId", "mcp.servers[1].oauthClientSecret", "mcp.servers[1].oauthCallbackPort", "mcp.servers[1].bogus",
            "mcp.servers[2].command", "mcp.servers[2].args", "mcp.servers[2].env", "mcp.servers[2].cwd", "mcp.servers[2].oauthClientName", "mcp.servers[2].oauthClientId", "mcp.servers[2].oauthClientSecret", "mcp.servers[2].oauthCallbackPort", "mcp.servers[2].bogus",
            "mcp.servers[3].command", "mcp.servers[3].args", "mcp.servers[3].env", "mcp.servers[3].cwd", "mcp.servers[3].bogus",
        ]));
    });

    test("compatibility mcpServers entry missing both command and url is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./bad-entry.json" }, (d) => {
            writeFileSync(join(d, "bad-entry.json"), JSON.stringify({ mcpServers: { x: { transport: "stdio" } } }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field.includes("mcpServers.x"))).toBe(true);
    });

    test("mcp sidecar with valid mcpServers object format is accepted", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./mcp.json" }, (d) => {
            writeFileSync(join(d, "mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] } } }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.mcp).toBe("./mcp.json");
    });

    test("mcp sidecar accepts the complete preferred transport field matrix", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./mcp.json" }, (d) => {
            writeFileSync(join(d, "mcp.json"), JSON.stringify({ mcp: { servers: [
                { name: "local", transport: "stdio", command: "echo", args: ["--flag"], env: { KEY: "value" }, cwd: ".", deferLoading: true },
                { name: "http", transport: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer token" }, deferLoading: false },
                { name: "streamable", transport: "streamable", url: "https://api.example.com/stream", headers: { Authorization: "Bearer token" }, oauthClientName: "PizzaPi", oauthClientId: "id", oauthClientSecret: "secret", oauthCallbackPort: 3000, deferLoading: true },
            ] } }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
    });

    // ── triggers/sigils sidecar and inline validation ──────────────────────

    test("triggers sidecar that isn't an array is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", triggers: "./triggers.json" }],
        }, (d) => {
            writeFileSync(join(d, "triggers.json"), JSON.stringify({ type: "x", label: "y" }));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].triggers" && i.message.includes("array"))).toBe(true);
    });

    test("triggers sidecar with malformed JSON is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", triggers: "./triggers.json" }],
        }, (d) => {
            writeFileSync(join(d, "triggers.json"), "not json at all");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].triggers" && i.message.includes("not valid JSON"))).toBe(true);
    });

    test("triggers sidecar pointing at a directory is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", triggers: "./triggers-dir.json" }],
        }, (d) => {
            mkdirSync(join(d, "triggers-dir.json"));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].triggers" && i.message.includes("regular file"))).toBe(true);
    });

    test("inline junk sigil entry (missing type/label) is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", sigils: [{ icon: "bug" }] }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].sigils[0].type")).toBe(true);
        expect(result.issues.some((i) => i.field === "services[0].sigils[0].label")).toBe(true);
    });

    test("inline junk trigger entry (unknown key, wrong description type) is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{
                id: "svc",
                label: "x",
                entry: "./service.ts",
                triggers: [{ type: "svc:event", label: "Event", description: 123, bogus: true }],
            }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].triggers[0].description")).toBe(true);
        expect(result.issues.some((i) => i.field === "services[0].triggers[0].bogus")).toBe(true);
    });

    test("malformed trigger params (bad type, multiselect without enum) is rejected", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{
                id: "svc",
                label: "x",
                entry: "./service.ts",
                triggers: [{
                    type: "svc:event",
                    label: "Event",
                    params: [
                        { name: "repo", label: "Repo", type: "stringly" },
                        { name: "mode", label: "Mode", type: "string", multiselect: true },
                    ],
                }],
            }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].triggers[0].params[0].type")).toBe(true);
        expect(result.issues.some((i) => i.field === "services[0].triggers[0].params[1].multiselect")).toBe(true);
    });

    test("valid sessionModes are accepted and malformed modes are actionable", () => {
        const validDir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.ts", sessionModes: [{ id: "work", label: "Work", workspace: "~/Documents/Workspace" }] }] });
        dirs.push(validDir);
        const valid = readOverlayManifest(validDir, provenance);
        expect(valid.overlay?.services?.[0].sessionModes).toHaveLength(1);
        const invalidDir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.ts", sessionModes: [{ id: "work", label: "Work", workspace: "~/x" }, { id: "work", label: "", workspace: "" }] }] });
        dirs.push(invalidDir);
        const invalid = readOverlayManifest(invalidDir, provenance);
        expect(invalid.issues.some((i) => i.field.endsWith("sessionModes[1].id") && i.message.includes("duplicate"))).toBe(true);
        expect(invalid.issues.some((i) => i.field.endsWith("sessionModes[1].label"))).toBe(true);
        expect(invalid.issues.some((i) => i.field.endsWith("sessionModes[1].workspace"))).toBe(true);
    });

    test("valid service modes scoping is accepted and malformed modes are rejected", () => {
        const validDir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.ts", modes: ["work"] }] });
        dirs.push(validDir);
        const valid = readOverlayManifest(validDir, provenance);
        expect(valid.overlay?.services?.[0].modes).toEqual(["work"]);
        const invalidDir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.ts", modes: ["work", ""] }] });
        dirs.push(invalidDir);
        const invalid = readOverlayManifest(invalidDir, provenance);
        expect(invalid.overlay).toBeNull();
        expect(invalid.issues.some((i) => i.field.endsWith("services[0].modes"))).toBe(true);
    });

    test("workspaces that escape the home directory are rejected", () => {
        for (const workspace of ["~/../elsewhere", "~/Documents/../../etc", "~/./x", "~", "~/", "/absolute", "~/..\\elsewhere", "~\\x"]) {
            const dir = fixturePkg({
                schemaVersion: 1,
                services: [{ id: "svc", label: "x", entry: "./service.ts", sessionModes: [{ id: "m", label: "M", workspace }] }],
            });
            dirs.push(dir);
            const result = readOverlayManifest(dir, provenance);
            expect(result.overlay).toBeNull();
            expect(result.issues.some((i) => i.field.endsWith("sessionModes[0].workspace"))).toBe(true);
        }
    });

    test("a full mode ui block is accepted and survives parsing", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{
                id: "svc",
                label: "x",
                entry: "./service.ts",
                sessionModes: [{
                    id: "work",
                    label: "Work",
                    workspace: "~/Documents/Workspace",
                    ui: {
                        preset: "work",
                        chrome: { git: false, files: true },
                        toolRendering: "activity",
                        vocabulary: { session: "task", sessions: "tasks" },
                        accent: "#7c3aed",
                        composerPlaceholder: "What do you need?",
                        home: {
                            greeting: "Good morning",
                            suggestions: [{ label: "Daily report", icon: "file-text", prompt: "Write my daily report" }],
                            recent: true,
                        },
                        artifacts: { enabled: true, extensions: ["pdf", "docx"] },
                        scheduled: true,
                    },
                }],
            }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toEqual([]);
        const mode = result.overlay?.services?.[0].sessionModes?.[0];
        expect(mode?.ui?.preset).toBe("work");
        expect(mode?.ui?.chrome?.git).toBe(false);
        expect(mode?.ui?.home?.suggestions?.[0]?.prompt).toBe("Write my daily report");
        expect(mode?.ui?.artifacts?.extensions).toEqual(["pdf", "docx"]);
    });

    test("malformed mode ui fields are rejected with actionable fields", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{
                id: "svc",
                label: "x",
                entry: "./service.ts",
                sessionModes: [{
                    id: "work",
                    label: "Work",
                    workspace: "~/Workspace",
                    ui: {
                        preset: "casual",
                        toolRendering: "terse",
                        chrome: { git: "no", bogus: true },
                        vocabulary: { session: "", nope: "x" },
                        scheduled: "yes",
                        home: { suggestions: [{ label: "x" }] },
                        artifacts: { extensions: [""] },
                        mystery: 1,
                    },
                }],
            }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        const fields = result.issues.map((i) => i.field);
        expect(fields).toContain("services[0].sessionModes[0].ui.preset");
        expect(fields).toContain("services[0].sessionModes[0].ui.toolRendering");
        expect(fields).toContain("services[0].sessionModes[0].ui.chrome.git");
        expect(fields).toContain("services[0].sessionModes[0].ui.chrome.bogus");
        expect(fields).toContain("services[0].sessionModes[0].ui.vocabulary.session");
        expect(fields).toContain("services[0].sessionModes[0].ui.vocabulary.nope");
        expect(fields).toContain("services[0].sessionModes[0].ui.scheduled");
        // A suggestion without a prompt is useless — the chip would do nothing.
        expect(fields).toContain("services[0].sessionModes[0].ui.home.suggestions[0].prompt");
        expect(fields).toContain("services[0].sessionModes[0].ui.artifacts.enabled");
        expect(fields).toContain("services[0].sessionModes[0].ui.artifacts.extensions");
        expect(fields).toContain("services[0].sessionModes[0].ui.mystery");
    });

    test("valid inline trigger and sigil definitions are accepted", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{
                id: "svc",
                label: "x",
                entry: "./service.ts",
                triggers: [{
                    type: "svc:event",
                    label: "Event",
                    description: "fires on stuff",
                    params: [{ name: "repo", label: "Repo", type: "string", required: true, enum: ["a", "b"], multiselect: true }],
                }],
                sigils: [{ type: "pr", label: "Pull Request", icon: "git-pull-request", aliases: ["mr"] }],
            }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.services?.[0]?.triggers).toBeDefined();
    });

    test("valid sidecar trigger/sigil JSON arrays are accepted", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", triggers: "./triggers.json", sigils: "./sigils.json" }],
        }, (d) => {
            writeFileSync(join(d, "triggers.json"), JSON.stringify([{ type: "svc:event", label: "Event" }]));
            writeFileSync(join(d, "sigils.json"), JSON.stringify([{ type: "pr", label: "Pull Request" }]));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
    });

    // ── agents/rules must resolve to a directory or a .md file ─────────────

    test("agent entry pointing at a non-.md file is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, agents: ["./service.ts"] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "agents[0]" && i.message.includes(".md"))).toBe(true);
    });

    test("rule entry pointing at a directory is accepted", () => {
        const dir = fixturePkg({ schemaVersion: 1, rules: ["./rules-dir"] }, (d) => {
            mkdirSync(join(d, "rules-dir"));
            writeFileSync(join(d, "rules-dir", "a.md"), "# hi");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
    });

    test("agent entry pointing at a .md file is accepted", () => {
        const dir = fixturePkg({ schemaVersion: 1, agents: ["./agent.md"] }, (d) => {
            writeFileSync(join(d, "agent.md"), "# agent");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
    });
});

describe("resolveConfinedPath", () => {
    test("accepts a clean relative path inside the root", () => {
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-confine-"));
        try {
            writeFileSync(join(dir, "a.ts"), "");
            const result = resolveConfinedPath(dir, "./a.ts");
            expect(result.ok).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
