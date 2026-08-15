import { describe, expect, test } from "bun:test";
import { cwdInWorkspace, findSessionMode, isArtifactPath, resolveModeUi } from "./mode-ui.js";
import type { ServiceModeDef } from "./shared.js";

const codingMode: ServiceModeDef = { id: "code", label: "Code", workspace: "/home/j/Projects" };
const workMode: ServiceModeDef = {
    id: "work",
    label: "Work",
    workspace: "/home/j/Workspace",
    ui: { preset: "work" },
};

describe("resolveModeUi", () => {
    test("no mode resolves to today's coding UI", () => {
        const ui = resolveModeUi(null);
        expect(ui.git).toBe(true);
        expect(ui.terminal).toBe(true);
        expect(ui.processes).toBe(true);
        expect(ui.diffs).toBe(true);
        expect(ui.toolRendering).toBe("detailed");
        expect(ui.sessionNoun).toBe("session");
        expect(ui.sessionNounPlural).toBe("sessions");
        expect(ui.newSessionLabel).toBe("New session");
        expect(ui.artifacts).toBe(false);
        expect(ui.scheduled).toBe(false);
    });

    test("a mode without a ui block is unchanged from the coding default", () => {
        expect(resolveModeUi(codingMode)).toEqual(resolveModeUi(null));
    });

    test("work preset hides coding chrome and switches tool rendering", () => {
        const ui = resolveModeUi(workMode);
        expect(ui.git).toBe(false);
        expect(ui.terminal).toBe(false);
        expect(ui.processes).toBe(false);
        expect(ui.diffs).toBe(false);
        // Files stay: a knowledge-work mode still needs its deliverables.
        expect(ui.files).toBe(true);
        expect(ui.toolRendering).toBe("activity");
    });

    test("explicit chrome flags override the preset in both directions", () => {
        const ui = resolveModeUi({
            ...workMode,
            ui: { preset: "work", chrome: { git: true, files: false } },
        });
        expect(ui.git).toBe(true);
        expect(ui.files).toBe(false);
        // Untouched flags still follow the preset.
        expect(ui.terminal).toBe(false);
    });

    test("explicit toolRendering overrides the preset default", () => {
        const ui = resolveModeUi({ ...workMode, ui: { preset: "work", toolRendering: "detailed" } });
        expect(ui.toolRendering).toBe("detailed");
    });

    test("vocabulary drives derived plural and action labels", () => {
        const ui = resolveModeUi({ ...workMode, ui: { vocabulary: { session: "task" } } });
        expect(ui.sessionNoun).toBe("task");
        expect(ui.sessionNounPlural).toBe("tasks");
        expect(ui.newSessionLabel).toBe("New task");
    });

    test("explicit plural and action labels win over derived ones", () => {
        const ui = resolveModeUi({
            ...workMode,
            ui: { vocabulary: { session: "brief", sessions: "briefs", newSession: "Start a brief" } },
        });
        expect(ui.sessionNounPlural).toBe("briefs");
        expect(ui.newSessionLabel).toBe("Start a brief");
    });

    test("home defaults to showing recent with no suggestions", () => {
        const ui = resolveModeUi(workMode);
        expect(ui.recent).toBe(true);
        expect(ui.suggestions).toEqual([]);
        expect(ui.greeting).toBeNull();
    });

    test("home config is surfaced verbatim", () => {
        const suggestions = [{ label: "Daily report", prompt: "Write my daily report", icon: "file-text" }];
        const ui = resolveModeUi({
            ...workMode,
            ui: { home: { greeting: "What are we working on?", suggestions, recent: false } },
        });
        expect(ui.greeting).toBe("What are we working on?");
        expect(ui.suggestions).toEqual(suggestions);
        expect(ui.recent).toBe(false);
    });

    test("artifacts default to the document set and normalize extensions", () => {
        const defaults = resolveModeUi({ ...workMode, ui: { artifacts: { enabled: true } } });
        expect(defaults.artifacts).toBe(true);
        expect(defaults.artifactExtensions).toContain("pdf");
        expect(defaults.artifactExtensions).toContain("docx");

        const custom = resolveModeUi({
            ...workMode,
            ui: { artifacts: { enabled: true, extensions: [".PDF", "Md"] } },
        });
        expect(custom.artifactExtensions).toEqual(["pdf", "md"]);
    });
});

describe("cwdInWorkspace", () => {
    test("matches the workspace itself and paths inside it", () => {
        expect(cwdInWorkspace("/home/j/Workspace", "/home/j/Workspace")).toBe(true);
        expect(cwdInWorkspace("/home/j/Workspace/clients/acme", "/home/j/Workspace")).toBe(true);
    });

    test("respects path boundaries — a sibling prefix is not a match", () => {
        expect(cwdInWorkspace("/home/j/Workspace-old", "/home/j/Workspace")).toBe(false);
        expect(cwdInWorkspace("/home/j/Work", "/home/j/Workspace")).toBe(false);
    });

    test("tolerates a trailing slash in the declared workspace", () => {
        expect(cwdInWorkspace("/home/j/Workspace/a", "/home/j/Workspace/")).toBe(true);
    });
});

describe("findSessionMode", () => {
    const modes = [codingMode, workMode];

    test("resolves a session by workspace containment", () => {
        expect(findSessionMode({ cwd: "/home/j/Workspace/acme" }, modes)?.id).toBe("work");
        expect(findSessionMode({ cwd: "/home/j/Projects/pizzapi" }, modes)?.id).toBe("code");
    });

    test("returns null for a session outside every workspace", () => {
        expect(findSessionMode({ cwd: "/tmp/scratch" }, modes)).toBeNull();
        expect(findSessionMode({ cwd: null }, modes)).toBeNull();
        expect(findSessionMode(null, modes)).toBeNull();
    });

    test("deepest workspace wins when modes nest", () => {
        const nested: ServiceModeDef = { id: "acme", label: "Acme", workspace: "/home/j/Workspace/acme" };
        expect(findSessionMode({ cwd: "/home/j/Workspace/acme/q3" }, [workMode, nested])?.id).toBe("acme");
    });

    test("never applies another runner's mode to a session", () => {
        const session = { cwd: "/home/j/Workspace", runnerId: "runner-b" };
        expect(findSessionMode(session, modes, "runner-a")).toBeNull();
        expect(findSessionMode(session, modes, "runner-b")?.id).toBe("work");
    });

    test("a session with no runner does not inherit a runner's mode", () => {
        // Paths only mean anything on the machine that announced the mode; a
        // runnerless session cannot be shown to be on it.
        expect(findSessionMode({ cwd: "/home/j/Workspace" }, modes, "runner-a")).toBeNull();
        expect(findSessionMode({ cwd: "/home/j/Workspace", runnerId: null }, modes, "runner-a")).toBeNull();
        // With no mode owner to compare against, containment still applies.
        expect(findSessionMode({ cwd: "/home/j/Workspace" }, modes)?.id).toBe("work");
    });
});

describe("isArtifactPath", () => {
    const enabled = resolveModeUi({ ...workMode, ui: { artifacts: { enabled: true, extensions: ["pdf", "md"] } } });

    test("matches configured extensions case-insensitively", () => {
        expect(isArtifactPath("/w/report.pdf", enabled)).toBe(true);
        expect(isArtifactPath("/w/NOTES.MD", enabled)).toBe(true);
    });

    test("rejects unconfigured extensions and extensionless paths", () => {
        expect(isArtifactPath("/w/script.ts", enabled)).toBe(false);
        expect(isArtifactPath("/w/Makefile", enabled)).toBe(false);
    });

    test("is always false when artifacts are disabled", () => {
        expect(isArtifactPath("/w/report.pdf", resolveModeUi(workMode))).toBe(false);
    });
});
