import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
    parseSkillFrontmatterFromString,
    scanSkillsDir,
    readSkillContent,
    writeSkill,
    deleteSkill,
    builtinSkillsDir,
    buildInteractiveSkillPaths,
    buildWorkerSkillPaths,
} from "./skills.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a unique temp directory for each test. */
function makeTmpDir(): string {
    const dir = join(tmpdir(), `pizzapi-skill-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Write a SKILL.md inside a subdirectory of the given skills dir. */
function writeSubdirSkill(skillsDir: string, name: string, content: string): string {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
}

/** Write a direct .md skill file in the root of the skills dir. */
function writeRootSkill(skillsDir: string, name: string, content: string): string {
    const filePath = join(skillsDir, `${name}.md`);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
}

const SKILL_WITH_DESCRIPTION = `---
name: my-skill
description: A helpful skill for testing.
---

# My Skill

Do the thing.
`;

const SKILL_QUOTED_DESCRIPTION = `---
name: quoted-skill
description: "A quoted description"
---

# Quoted Skill
`;

const SKILL_SINGLE_QUOTED = `---
name: single-quoted
description: 'Single-quoted description'
---

# Single Quoted
`;

const SKILL_NO_DESCRIPTION = `---
name: no-desc
---

# No Description
`;

const SKILL_NO_FRONTMATTER = `# Just Markdown

No frontmatter here.
`;

const SKILL_EMPTY_DESCRIPTION = `---
name: empty-desc
description:
---

# Empty
`;

// ── parseSkillFrontmatterFromString ───────────────────────────────────────────

describe("parseSkillFrontmatterFromString", () => {
    test("parses a plain description", () => {
        const result = parseSkillFrontmatterFromString(SKILL_WITH_DESCRIPTION);
        expect(result.description).toBe("A helpful skill for testing.");
    });

    test("strips double quotes from description", () => {
        const result = parseSkillFrontmatterFromString(SKILL_QUOTED_DESCRIPTION);
        expect(result.description).toBe("A quoted description");
    });

    test("strips single quotes from description", () => {
        const result = parseSkillFrontmatterFromString(SKILL_SINGLE_QUOTED);
        expect(result.description).toBe("Single-quoted description");
    });

    test("returns empty string when description is missing", () => {
        const result = parseSkillFrontmatterFromString(SKILL_NO_DESCRIPTION);
        expect(result.description).toBe("");
    });

    test("returns empty string when there is no frontmatter", () => {
        const result = parseSkillFrontmatterFromString(SKILL_NO_FRONTMATTER);
        expect(result.description).toBe("");
    });

    test("returns empty string for empty description value", () => {
        const result = parseSkillFrontmatterFromString(SKILL_EMPTY_DESCRIPTION);
        expect(result.description).toBe("");
    });

    test("returns empty string for empty content", () => {
        const result = parseSkillFrontmatterFromString("");
        expect(result.description).toBe("");
    });

    test("returns empty string when closing --- is missing", () => {
        const result = parseSkillFrontmatterFromString("---\nname: broken\ndescription: oops");
        expect(result.description).toBe("");
    });

    test("handles multiline frontmatter with description not on first line", () => {
        const content = `---
name: multi
version: 1.0
description: Found it!
license: MIT
---

# Multi
`;
        const result = parseSkillFrontmatterFromString(content);
        expect(result.description).toBe("Found it!");
    });

    test("handles Windows-style line endings", () => {
        const content = "---\r\nname: win\r\ndescription: Windows skill\r\n---\r\n\r\n# Win";
        const result = parseSkillFrontmatterFromString(content);
        expect(result.description).toBe("Windows skill");
    });
});

// ── scanSkillsDir ─────────────────────────────────────────────────────────────

describe("scanSkillsDir", () => {
    let dir: string;

    beforeEach(() => {
        dir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("returns empty array for non-existent directory", () => {
        const result = scanSkillsDir(join(dir, "nope"));
        expect(result).toEqual([]);
    });

    test("returns empty array for empty directory", () => {
        const result = scanSkillsDir(dir);
        expect(result).toEqual([]);
    });

    test("discovers subdirectory skills (SKILL.md)", () => {
        writeSubdirSkill(dir, "my-skill", SKILL_WITH_DESCRIPTION);
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("my-skill");
        expect(result[0].description).toBe("A helpful skill for testing.");
        expect(result[0].filePath).toBe(join(dir, "my-skill", "SKILL.md"));
    });

    test("discovers direct .md files in root", () => {
        writeRootSkill(dir, "quick-skill", SKILL_WITH_DESCRIPTION);
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("quick-skill");
        expect(result[0].description).toBe("A helpful skill for testing.");
        expect(result[0].filePath).toBe(join(dir, "quick-skill.md"));
    });

    test("discovers both subdirectory and root skills", () => {
        writeSubdirSkill(dir, "sub-skill", SKILL_WITH_DESCRIPTION);
        writeRootSkill(dir, "root-skill", SKILL_QUOTED_DESCRIPTION);
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(2);
        const names = result.map((s) => s.name).sort();
        expect(names).toEqual(["root-skill", "sub-skill"]);
    });

    test("ignores subdirectories without SKILL.md", () => {
        mkdirSync(join(dir, "empty-dir"));
        writeFileSync(join(dir, "empty-dir", "README.md"), "# Not a skill", "utf-8");
        const result = scanSkillsDir(dir);
        expect(result).toEqual([]);
    });

    test("ignores non-.md files in root", () => {
        writeFileSync(join(dir, "notes.txt"), "not a skill", "utf-8");
        writeFileSync(join(dir, "config.json"), "{}", "utf-8");
        const result = scanSkillsDir(dir);
        expect(result).toEqual([]);
    });

    test("ignores hidden entries (dotfiles/dotdirs)", () => {
        writeRootSkill(dir, ".hidden-skill", SKILL_WITH_DESCRIPTION);
        mkdirSync(join(dir, ".hidden-dir"));
        writeFileSync(join(dir, ".hidden-dir", "SKILL.md"), SKILL_WITH_DESCRIPTION, "utf-8");
        const result = scanSkillsDir(dir);
        expect(result).toEqual([]);
    });

    test("handles skill with no description (empty string)", () => {
        writeSubdirSkill(dir, "no-desc", SKILL_NO_DESCRIPTION);
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].description).toBe("");
    });

    test("handles mixed valid and invalid skills", () => {
        writeSubdirSkill(dir, "valid-skill", SKILL_WITH_DESCRIPTION);
        writeRootSkill(dir, "no-frontmatter", SKILL_NO_FRONTMATTER);
        mkdirSync(join(dir, "no-skill-md")); // dir without SKILL.md
        writeFileSync(join(dir, "readme.txt"), "ignore me", "utf-8");

        const result = scanSkillsDir(dir);
        // valid-skill from subdir + no-frontmatter.md from root (it's still a .md file)
        expect(result).toHaveLength(2);
        const names = result.map((s) => s.name).sort();
        expect(names).toEqual(["no-frontmatter", "valid-skill"]);
    });

    test("is case-insensitive for .md extension", () => {
        writeFileSync(join(dir, "UPPER.MD"), SKILL_WITH_DESCRIPTION, "utf-8");
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("UPPER");
    });

    test("skips broken symlinks without crashing other skills", () => {
        writeSubdirSkill(dir, "good-skill", SKILL_WITH_DESCRIPTION);
        // Create a broken symlink as a .md file
        const brokenLink = join(dir, "broken.md");
        try {
            require("node:fs").symlinkSync("/nonexistent/path/skill.md", brokenLink);
        } catch {
            return; // Skip if symlinks not supported
        }
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("good-skill");
    });

    test("handles binary content in .md files gracefully", () => {
        writeSubdirSkill(dir, "valid-skill", SKILL_WITH_DESCRIPTION);
        const binaryPath = join(dir, "binary-garbage.md");
        require("node:fs").writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x89]));
        const result = scanSkillsDir(dir);
        // Both should load without crashing
        expect(result.length).toBeGreaterThanOrEqual(1);
        const valid = result.find(s => s.name === "valid-skill");
        expect(valid?.description).toBe("A helpful skill for testing.");
    });

    test("handles broken SKILL.md symlink in subdirectory", () => {
        writeSubdirSkill(dir, "good-skill", SKILL_WITH_DESCRIPTION);
        // Create a subdirectory with a broken SKILL.md symlink
        const badDir = join(dir, "bad-skill");
        mkdirSync(badDir, { recursive: true });
        try {
            require("node:fs").symlinkSync("/nonexistent/SKILL.md", join(badDir, "SKILL.md"));
        } catch {
            return; // Skip if symlinks not supported
        }
        const result = scanSkillsDir(dir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("good-skill");
    });
});

// ── readSkillContent ──────────────────────────────────────────────────────────

describe("readSkillContent", () => {
    let dir: string;

    beforeEach(() => {
        dir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("reads subdirectory skill content", () => {
        writeSubdirSkill(dir, "my-skill", SKILL_WITH_DESCRIPTION);
        const content = readSkillContent("my-skill", dir);
        expect(content).toBe(SKILL_WITH_DESCRIPTION);
    });

    test("reads direct .md skill content", () => {
        writeRootSkill(dir, "root-skill", SKILL_QUOTED_DESCRIPTION);
        const content = readSkillContent("root-skill", dir);
        expect(content).toBe(SKILL_QUOTED_DESCRIPTION);
    });

    test("prefers subdirectory over direct file", () => {
        const subContent = "---\nname: dupe\ndescription: From subdir\n---\n# Sub";
        const rootContent = "---\nname: dupe\ndescription: From root\n---\n# Root";
        writeSubdirSkill(dir, "dupe", subContent);
        writeRootSkill(dir, "dupe", rootContent);
        const content = readSkillContent("dupe", dir);
        expect(content).toBe(subContent);
    });

    test("returns null for non-existent skill", () => {
        const content = readSkillContent("nope", dir);
        expect(content).toBeNull();
    });
});

// ── writeSkill ────────────────────────────────────────────────────────────────

describe("writeSkill", () => {
    let dir: string;

    beforeEach(() => {
        dir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("creates a new skill in subdirectory layout", async () => {
        await writeSkill("new-skill", SKILL_WITH_DESCRIPTION, dir);
        const filePath = join(dir, "new-skill", "SKILL.md");
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf-8")).toBe(SKILL_WITH_DESCRIPTION);
    });

    test("overwrites existing skill content", async () => {
        await writeSkill("update-me", "old content", dir);
        await writeSkill("update-me", "new content", dir);
        const filePath = join(dir, "update-me", "SKILL.md");
        expect(readFileSync(filePath, "utf-8")).toBe("new content");
    });

    test("creates nested directory structure", async () => {
        const nestedDir = join(dir, "nested", "path");
        await writeSkill("deep-skill", SKILL_WITH_DESCRIPTION, nestedDir);
        expect(existsSync(join(nestedDir, "deep-skill", "SKILL.md"))).toBe(true);
    });
});

// ── deleteSkill ───────────────────────────────────────────────────────────────

describe("deleteSkill", () => {
    let dir: string;

    beforeEach(() => {
        dir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("deletes a subdirectory skill", async () => {
        await writeSkill("doomed", SKILL_WITH_DESCRIPTION, dir);
        expect(existsSync(join(dir, "doomed", "SKILL.md"))).toBe(true);

        const result = deleteSkill("doomed", dir);
        expect(result).toBe(true);
        expect(existsSync(join(dir, "doomed"))).toBe(false);
    });

    test("deletes a direct .md skill", () => {
        writeRootSkill(dir, "root-doomed", SKILL_WITH_DESCRIPTION);
        expect(existsSync(join(dir, "root-doomed.md"))).toBe(true);

        const result = deleteSkill("root-doomed", dir);
        expect(result).toBe(true);
        expect(existsSync(join(dir, "root-doomed.md"))).toBe(false);
    });

    test("prefers deleting subdirectory over direct file", async () => {
        await writeSkill("both", "subdir content", dir);
        writeRootSkill(dir, "both", "root content");

        const result = deleteSkill("both", dir);
        expect(result).toBe(true);
        // Subdirectory should be gone
        expect(existsSync(join(dir, "both"))).toBe(false);
        // Root file should still exist
        expect(existsSync(join(dir, "both.md"))).toBe(true);
    });

    test("returns false for non-existent skill", () => {
        const result = deleteSkill("ghost", dir);
        expect(result).toBe(false);
    });
});

// ── buildInteractiveSkillPaths ────────────────────────────────────────────────

describe("buildInteractiveSkillPaths", () => {
    test("includes global and project-local .pizzapi/skills dirs", () => {
        const paths = buildInteractiveSkillPaths("/projects/my-app");
        const home = require("os").homedir();
        expect(paths).toContain(join(home, ".pizzapi", "skills"));
        expect(paths).toContain(join("/projects/my-app", ".pizzapi", "skills"));
    });

    test("appends config skill paths", () => {
        const paths = buildInteractiveSkillPaths("/projects/my-app", [
            "/extra/skills",
            "~/my-skills",
        ]);
        expect(paths).toContain("/extra/skills");
        // ~ should be expanded
        const home = require("os").homedir();
        expect(paths).toContain(join(home, "my-skills"));
    });

    test("filters out empty and whitespace-only config entries", () => {
        const paths = buildInteractiveSkillPaths("/tmp", ["", "  ", "/valid"]);
        // Should have 3 default paths (builtin + global + project) + 1 valid config path
        expect(paths).toHaveLength(4);
        expect(paths[3]).toBe("/valid");
    });

    test("handles undefined configSkills", () => {
        const paths = buildInteractiveSkillPaths("/tmp");
        expect(paths).toHaveLength(3);
    });

    test("handles empty configSkills array", () => {
        const paths = buildInteractiveSkillPaths("/tmp", []);
        expect(paths).toHaveLength(3);
    });
});

// ── buildWorkerSkillPaths ─────────────────────────────────────────────────────

describe("buildWorkerSkillPaths", () => {
    test("includes expected default paths", () => {
        const home = require("os").homedir();
        const paths = buildWorkerSkillPaths("/projects/my-app");
        expect(paths).toContain(join("/projects/my-app", ".pizzapi", "skills"));
        expect(paths).toContain(join(home, ".pizzapi", "agents"));
        expect(paths).toContain(join("/projects/my-app", ".pizzapi", "agents"));
        expect(paths).toContain(join("/projects/my-app", ".agents", "skills"));
        expect(paths).toContain(join("/projects/my-app", ".agents", "agents"));
    });

    test("does NOT include global ~/.pizzapi/skills (discovered via agentDir)", () => {
        const home = require("os").homedir();
        const paths = buildWorkerSkillPaths("/projects/my-app");
        expect(paths).not.toContain(join(home, ".pizzapi", "skills"));
    });

    test("appends config skill paths", () => {
        const paths = buildWorkerSkillPaths("/tmp", ["/custom/path"]);
        expect(paths).toContain("/custom/path");
    });

    test("expands tilde in config paths", () => {
        const home = require("os").homedir();
        const paths = buildWorkerSkillPaths("/tmp", ["~/custom"]);
        expect(paths).toContain(join(home, "custom"));
    });

    test("handles undefined configSkills", () => {
        const paths = buildWorkerSkillPaths("/tmp");
        expect(paths).toHaveLength(6); // 6 default paths (builtin + 5 existing)
    });
});

// ── Integration: scan → read → write → delete lifecycle ──────────────────────

describe("skill lifecycle", () => {
    let dir: string;

    beforeEach(() => {
        dir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("full CRUD cycle", async () => {
        // Initially empty
        expect(scanSkillsDir(dir)).toEqual([]);

        // Create
        await writeSkill("test-skill", SKILL_WITH_DESCRIPTION, dir);
        const scanned = scanSkillsDir(dir);
        expect(scanned).toHaveLength(1);
        expect(scanned[0].name).toBe("test-skill");
        expect(scanned[0].description).toBe("A helpful skill for testing.");

        // Read
        const content = readSkillContent("test-skill", dir);
        expect(content).toBe(SKILL_WITH_DESCRIPTION);

        // Update
        const updated = SKILL_WITH_DESCRIPTION.replace("A helpful skill for testing.", "Updated description.");
        await writeSkill("test-skill", updated, dir);
        const rescanned = scanSkillsDir(dir);
        expect(rescanned).toHaveLength(1);
        expect(rescanned[0].description).toBe("Updated description.");

        // Delete
        const deleted = deleteSkill("test-skill", dir);
        expect(deleted).toBe(true);
        expect(scanSkillsDir(dir)).toEqual([]);
        expect(readSkillContent("test-skill", dir)).toBeNull();
    });

    test("multiple skills coexist", async () => {
        await writeSkill("alpha", `---\nname: alpha\ndescription: First\n---\n# A`, dir);
        await writeSkill("beta", `---\nname: beta\ndescription: Second\n---\n# B`, dir);
        writeRootSkill(dir, "gamma", `---\nname: gamma\ndescription: Third\n---\n# C`);

        const skills = scanSkillsDir(dir);
        expect(skills).toHaveLength(3);
        const names = skills.map((s) => s.name).sort();
        expect(names).toEqual(["alpha", "beta", "gamma"]);

        // Delete one, others remain
        deleteSkill("beta", dir);
        const remaining = scanSkillsDir(dir);
        expect(remaining).toHaveLength(2);
        expect(remaining.map((s) => s.name).sort()).toEqual(["alpha", "gamma"]);
    });
});
