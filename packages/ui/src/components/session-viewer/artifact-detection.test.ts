import { describe, expect, test } from "bun:test";
import { resolveModeUi } from "@pizzapi/protocol";
import { artifactKindFor, detectArtifact, extensionOf, writtenPath } from "./artifact-detection";

const workMode = {
    id: "work",
    label: "Work",
    workspace: "/w",
    ui: { preset: "work" as const, artifacts: { enabled: true } },
};
const workUi = resolveModeUi(workMode);
const codingUi = resolveModeUi(null);

describe("extensionOf / artifactKindFor", () => {
    test("maps extensions to preview kinds", () => {
        expect(artifactKindFor("/w/a.md")).toBe("markdown");
        expect(artifactKindFor("/w/a.PDF")).toBe("pdf");
        expect(artifactKindFor("/w/a.csv")).toBe("csv");
        expect(artifactKindFor("/w/a.xlsx")).toBe("xlsx");
        expect(artifactKindFor("/w/a.xls")).toBe("xlsx");
        expect(artifactKindFor("/w/a.ods")).toBe("xlsx");
        expect(artifactKindFor("/w/a.pptx")).toBe("pptx");
        expect(artifactKindFor("/w/a.html")).toBe("html");
        expect(artifactKindFor("/w/a.png")).toBe("image");
    });

    test("formats browsers cannot render inline fall back to download", () => {
        expect(artifactKindFor("/w/a.docx")).toBe("download");
        expect(artifactKindFor("/w/Makefile")).toBe("download");
    });

    test("extensionOf is case-insensitive and tolerates none", () => {
        expect(extensionOf("/w/a.MD")).toBe("md");
        expect(extensionOf("/w/Makefile")).toBeNull();
    });
});

describe("writtenPath", () => {
    test("reads the path from write-style tools", () => {
        expect(writtenPath("write", { file_path: "/w/a.md" })).toBe("/w/a.md");
        expect(writtenPath("edit", { path: "/w/a.md" })).toBe("/w/a.md");
        expect(writtenPath("mcp__fs__write_file", { file_path: "/w/a.md" })).toBe("/w/a.md");
    });

    test("ignores tools that do not write files", () => {
        expect(writtenPath("read", { file_path: "/w/a.md" })).toBeNull();
        expect(writtenPath("bash", { command: "ls" })).toBeNull();
    });

    test("ignores blank paths", () => {
        expect(writtenPath("write", { file_path: "   " })).toBeNull();
        expect(writtenPath("write", {})).toBeNull();
    });
});

describe("detectArtifact", () => {
    test("detects a deliverable written by a work mode", () => {
        expect(detectArtifact("write", { file_path: "/w/report.pdf" }, workUi)).toEqual({
            path: "/w/report.pdf",
            kind: "pdf",
        });
    });

    test("never fires for a mode without artifacts enabled", () => {
        expect(detectArtifact("write", { file_path: "/w/report.pdf" }, codingUi)).toBeNull();
        expect(detectArtifact("write", { file_path: "/w/report.pdf" }, null)).toBeNull();
    });

    test("ignores extensions the mode does not claim", () => {
        const narrow = resolveModeUi({ ...workMode, ui: { artifacts: { enabled: true, extensions: ["pdf"] } } });
        expect(detectArtifact("write", { file_path: "/w/notes.md" }, narrow)).toBeNull();
        expect(detectArtifact("write", { file_path: "/w/report.pdf" }, narrow)?.kind).toBe("pdf");
    });

    test("source files are not deliverables", () => {
        expect(detectArtifact("write", { file_path: "/w/script.ts" }, workUi)).toBeNull();
    });
});

describe("detectArtifact — explicit present_artifact hand-off", () => {
    test("honors an explicit hand-off with a title", () => {
        expect(detectArtifact("present_artifact", { path: "/w/report.pdf", title: "Q3 Report" }, workUi)).toEqual({
            path: "/w/report.pdf",
            kind: "pdf",
            title: "Q3 Report",
        });
    });

    test("an explicit kind overrides the extension guess", () => {
        expect(detectArtifact("present_artifact", { path: "/w/page", kind: "html" }, workUi)?.kind).toBe("html");
    });

    test("a bogus kind falls back to the extension", () => {
        expect(detectArtifact("present_artifact", { path: "/w/a.csv", kind: "nonsense" }, workUi)?.kind).toBe("csv");
    });

    test("explicit intent beats the extension allowlist", () => {
        // A narrow mode only claims pdf, but an explicit hand-off of a docx is
        // still a deliverable — the model chose to present it.
        const narrow = resolveModeUi({ ...workMode, ui: { artifacts: { enabled: true, extensions: ["pdf"] } } });
        expect(detectArtifact("present_artifact", { path: "/w/notes.docx" }, narrow)).toEqual({
            path: "/w/notes.docx",
            kind: "download",
        });
    });

    test("the MCP-prefixed form is recognized", () => {
        expect(detectArtifact("mcp__pizzawork__present_artifact", { path: "/w/a.md" }, workUi)?.path).toBe("/w/a.md");
    });

    test("works in code mode without artifacts enabled", () => {
        expect(detectArtifact("present_artifact", { path: "/w/a.md" }, codingUi)).toEqual({
            path: "/w/a.md",
            kind: "markdown",
        });
        expect(detectArtifact("present_artifact", { path: "/w/a.md" }, null)).toEqual({
            path: "/w/a.md",
            kind: "markdown",
        });
    });

    test("a hand-off with no path is ignored", () => {
        expect(detectArtifact("present_artifact", { title: "nothing" }, workUi)).toBeNull();
    });
});

describe("tool input arriving as a JSON string", () => {
    test("still produces an artifact", () => {
        // Some providers serialize tool input; dropping those silently lost a
        // perfectly good deliverable.
        expect(detectArtifact("write", JSON.stringify({ file_path: "/w/report.pdf" }), workUi)).toEqual({
            path: "/w/report.pdf",
            kind: "pdf",
        });
    });

    test("non-JSON strings are ignored rather than throwing", () => {
        expect(detectArtifact("write", "not json", workUi)).toBeNull();
    });
});
