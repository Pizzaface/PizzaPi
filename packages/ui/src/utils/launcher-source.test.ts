import { describe, expect, test } from "bun:test";
import { resolveLauncherSource } from "./servicePanelUtils";

type P = { serviceId: string; launcher?: { surface: string } };
const launcherPanel: P = { serviceId: "pizzawork", launcher: { surface: "session-list" } };
const dockPanel: P = { serviceId: "github" };

// Two runners, only the second one owns the launcher — the shape that actually
// broke: picking "first runner with any panel" lands on the launcher-less one.
const runners = [
    { runnerId: "air", panels: [dockPanel] },
    { runnerId: "mini", panels: [dockPanel, launcherPanel] },
];

describe("resolveLauncherSource", () => {
    test("no session open: falls back to the runner that owns a launcher", () => {
        expect(resolveLauncherSource([], null, runners, null)).toEqual({
            panels: [dockPanel, launcherPanel],
            runnerId: "mini",
        });
    });

    test("skips the active runner when it announces no launcher", () => {
        expect(resolveLauncherSource([dockPanel], "air", runners, null).runnerId).toBe("mini");
    });

    test("prefers the runner selected in the sidebar", () => {
        const both = [
            { runnerId: "air", panels: [launcherPanel] },
            { runnerId: "mini", panels: [launcherPanel] },
        ];
        expect(resolveLauncherSource([], null, both, "mini").runnerId).toBe("mini");
    });

    test("session open on the launcher's runner: uses its announced panels", () => {
        expect(resolveLauncherSource([launcherPanel], "mini", runners, null)).toEqual({
            panels: [launcherPanel],
            runnerId: "mini",
        });
    });

    test("no launcher anywhere: empty, not a crash", () => {
        expect(resolveLauncherSource([], null, [{ runnerId: "air", panels: [dockPanel] }], null))
            .toEqual({ panels: [], runnerId: null });
    });
});
