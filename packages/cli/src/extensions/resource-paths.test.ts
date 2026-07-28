import { describe, expect, test } from "bun:test";
import { createResourcePathsExtension } from "./resource-paths.js";
import { buildPromptTemplatePaths, buildSkillPaths } from "../skills.js";
import { getPluginSkillPaths } from "./claude-plugins.js";

describe("createResourcePathsExtension", () => {
    test("resources_discover handler returns buildSkillPaths + plugin paths and buildPromptTemplatePaths for event.cwd", async () => {
        const cwd = process.cwd();
        const configSkills = ["/tmp/extra-skills"];

        let handler: ((event: { cwd: string; reason: string }) => unknown) | undefined;
        const pi = {
            on: (event: string, fn: typeof handler) => {
                if (event === "resources_discover") handler = fn;
            },
        };

        createResourcePathsExtension({ configSkills })(pi as any);

        expect(handler).toBeDefined();
        const result = await handler!({ cwd, reason: "startup" }) as {
            skillPaths: string[];
            promptPaths: string[];
        };

        const expectedSkillPaths = [...buildSkillPaths(cwd, configSkills), ...getPluginSkillPaths(cwd)];
        expect(result.skillPaths).toEqual(expectedSkillPaths);
        expect(result.promptPaths).toEqual(buildPromptTemplatePaths(cwd));
    });

    test("skipPlugins omits plugin skill paths", async () => {
        const cwd = process.cwd();
        let handler: ((event: { cwd: string; reason: string }) => unknown) | undefined;
        const pi = {
            on: (event: string, fn: typeof handler) => {
                if (event === "resources_discover") handler = fn;
            },
        };

        createResourcePathsExtension({ skipPlugins: true })(pi as any);
        const result = await handler!({ cwd, reason: "startup" }) as { skillPaths: string[] };

        expect(result.skillPaths).toEqual(buildSkillPaths(cwd, undefined));
    });

    test("dual-path: DefaultResourceLoader constructor still wires additionalSkillPaths/additionalPromptTemplatePaths in worker.ts and index.ts", async () => {
        // Belt-and-suspenders safety gate (p23-b): resources_discover is
        // additive, not a replacement. Both call sites must still pass the
        // constructor options directly to DefaultResourceLoader so skills load
        // even if an extension's resources_discover handler never runs.
        const workerSrc = await Bun.file(new URL("../runner/worker.ts", import.meta.url)).text();
        const indexSrc = await Bun.file(new URL("../index.ts", import.meta.url)).text();

        for (const src of [workerSrc, indexSrc]) {
            expect(src).toContain("additionalSkillPaths");
            expect(src).toContain("additionalPromptTemplatePaths");
        }
    });
});
