import { describe, test, expect } from "bun:test";
import { reloadResourcesExtension } from "./reload-resources.js";

function install() {
    const commands = new Map<string, any>();
    const pi: any = {
        registerCommand: (name: string, def: any) => commands.set(name, def),
        on: () => {},
    };
    reloadResourcesExtension(pi);
    return commands;
}

describe("reloadResourcesExtension", () => {
    test("registers /skills", () => {
        expect(install().has("skills")).toBe(true);
    });

    test("reload subcommand (and bare /skills) calls ctx.reload()", async () => {
        const cmd = install().get("skills");
        let reloads = 0;
        const ctx = { reload: async () => { reloads++; }, ui: { notify: () => {} } };

        await cmd.handler("", ctx);
        await cmd.handler("reload", ctx);
        expect(reloads).toBe(2);
    });

    test("unknown subcommand does not reload", async () => {
        const cmd = install().get("skills");
        let reloads = 0;
        const notices: string[] = [];
        await cmd.handler("wat", { reload: async () => { reloads++; }, ui: { notify: (m: string) => notices.push(m) } });
        expect(reloads).toBe(0);
        expect(notices.join()).toContain("Usage");
    });

    test("reload failures are reported, not thrown", async () => {
        const cmd = install().get("skills");
        const notices: string[] = [];
        await cmd.handler("reload", {
            reload: async () => { throw new Error("boom"); },
            ui: { notify: (m: string) => notices.push(m) },
        });
        expect(notices.some((n) => n.includes("boom"))).toBe(true);
    });

    test("argument completions offer reload", () => {
        const cmd = install().get("skills");
        expect(cmd.getArgumentCompletions("re")?.[0].value).toBe("reload");
        expect(cmd.getArgumentCompletions("zzz")).toBeNull();
    });
});
