import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

// Own DOM: other test files in the same process can leave `window` unset.
const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement", "MutationObserver", "Event", "HTMLInputElement"]) {
    (globalThis as any)[key] = key === "window" ? win : (win as any)[key];
}

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { PluginsView, toPluginsViewData } = await import("./PluginsView");
type PluginsViewData = import("./PluginsView").PluginsViewData;
afterEach(cleanup);

const data: PluginsViewData = {
    notice: "Installed demo@market",
    overview: {
        plugins: [{
            name: "demo",
            description: "A demo plugin",
            rootPath: "/p/demo",
            commands: [{ name: "go", description: "Go" }],
            hookEvents: ["PreToolUse", "Notification"],
            skills: [{ name: "demo-skill" }],
            agents: [{ name: "helper" }],
            rules: [],
            hasMcp: false,
            hasAgents: true,
            source: "marketplace",
            key: "demo@market",
            marketplace: "market",
        }],
        disabled: [{ key: "old@market", name: "old", marketplace: "market" }],
        marketplaces: [{ name: "market", source: "acme/market", pluginCount: 3 }],
        packages: [{ source: "npm:@acme/ext", scope: "project", installedPath: "/w/.pizzapi/npm/ext" }],
        packagesCwd: "/work/repo",
    },
};

const browsing: PluginsViewData = {
    ...data,
    notice: undefined,
    catalog: {
        name: "market",
        plugins: [
            { name: "fresh", key: "fresh@market", installed: false, enabled: false, category: "dev" },
            ...Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, key: `p${i}@market`, description: i === 7 ? "needle" : undefined, category: i % 2 ? "db" : "dev", installed: true, enabled: true })),
        ],
    },
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found as HTMLButtonElement;
}

describe("PluginsView", () => {
    test("renders overview sections and plugin details", () => {
        const { container, getByText, getAllByText } = render(<PluginsView data={data} />);
        expect(getByText("Installed demo@market")).toBeTruthy();
        // Disabled row shows its marketplace; the loaded plugin's source lives in its details.
        expect(getAllByText("@market").length).toBe(1);
        // Read-only: no action buttons.
        expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Disable")).toBe(false);

        fireEvent.click(container.querySelector('[aria-label="Show details for demo"]')!);
        expect(getByText("/demo:go")).toBeTruthy();
        expect(getByText("demo-skill")).toBeTruthy();
        expect(getByText("helper")).toBeTruthy();
        expect(getByText("PreToolUse → tool_call")).toBeTruthy();
        expect(getByText("Notification (not adapted)")).toBeTruthy();
        expect(getAllByText("@market").length).toBe(2);
    });

    test("actions dispatch /plugin args; destructive ones need a second click", async () => {
        const onCommand = mock(async (_args: string[]) => {});
        const { container } = render(<PluginsView data={data} onCommand={onCommand} />);

        await act(async () => { fireEvent.click(button(container, "Disable")); });
        expect(onCommand).toHaveBeenLastCalledWith(["disable", "demo@market"]);

        await act(async () => { fireEvent.click(button(container, "Enable")); });
        expect(onCommand).toHaveBeenLastCalledWith(["enable", "old@market"]);

        const calls = onCommand.mock.calls.length;
        await act(async () => { fireEvent.click(button(container, "Remove")); });
        expect(onCommand.mock.calls.length).toBe(calls);
        await act(async () => { fireEvent.click(button(container, "Confirm remove?")); });
        expect(onCommand).toHaveBeenLastCalledWith(["marketplace", "remove", "market"]);

        const input = container.querySelector('input[aria-label="Marketplace source"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { value: "owner/repo" } });
            fireEvent.submit(input.closest("form")!);
        });
        expect(onCommand).toHaveBeenLastCalledWith(["marketplace", "add", "owner/repo"]);
    });

    test("browse mode replaces the overview with a searchable, paged catalog", async () => {
        const onCommand = mock(async (_args: string[]) => {});
        const { container, queryByText } = render(<PluginsView data={browsing} onCommand={onCommand} />);
        expect(container.textContent).not.toContain("Claude plugins");
        expect(queryByText("p15")).toBeNull(); // paged
        await act(async () => { fireEvent.click(button(container, "Show more (31 left)")); });
        expect(queryByText("p15")).toBeTruthy();

        await act(async () => { fireEvent.click(button(container, "Install")); });
        expect(onCommand).toHaveBeenLastCalledWith(["install", "fresh@market"]);
        fireEvent.click(button(container, "db"));
        expect(queryByText("fresh")).toBeNull();
        expect(queryByText("p1")).toBeTruthy();

        fireEvent.click(button(container, "All"));
        const search = container.querySelector('input[aria-label="Search plugins"]') as HTMLInputElement;
        fireEvent.change(search, { target: { value: "needle" } });
        expect(queryByText("p7")).toBeTruthy();
        expect(queryByText("p1")).toBeNull();

        // Back returns to the overview locally — no command sent.
        const calls = onCommand.mock.calls.length;
        fireEvent.click(button(container, "Back"));
        expect(onCommand.mock.calls.length).toBe(calls);
        expect(container.textContent).toContain("Claude plugins");
    });

    test("browse mode survives a catalog-less result and re-derives install state", () => {
        const { container, queryByText, rerender } = render(<PluginsView data={browsing} onCommand={async () => {}} />);
        expect(button(container, "Install")).toBeTruthy();
        // Install result: no catalog, fresh overview now includes the plugin.
        const after: PluginsViewData = {
            overview: { ...data.overview, plugins: [...data.overview.plugins, { ...data.overview.plugins[0], name: "fresh", key: "fresh@market" }] },
        };
        rerender(<PluginsView data={after} onCommand={async () => {}} />);
        expect(container.textContent).not.toContain("Claude plugins");
        expect(queryByText("fresh")?.closest("li")?.textContent).toContain("Installed");
    });

    test("Update re-fetches by name (no catalog → stays on overview)", async () => {
        const onCommand = mock(async (_args: string[]) => {});
        const { container } = render(<PluginsView data={{ overview: data.overview }} onCommand={onCommand} />);
        await act(async () => { fireEvent.click(button(container, "Update")); });
        expect(onCommand).toHaveBeenLastCalledWith(["marketplace", "update", "market"]);
    });

    test("pi packages: list, scoped remove, update, project-scoped install", async () => {
        const onCommand = mock(async (_args: string[]) => {});
        const { container, getByText } = render(<PluginsView data={data} onCommand={onCommand} sections={["packages"]} />);
        expect(getByText("npm:@acme/ext")).toBeTruthy();
        // Plugins section hidden.
        expect(container.textContent).not.toContain("Claude plugins");

        await act(async () => { fireEvent.click(button(container, "Remove")); });
        await act(async () => { fireEvent.click(button(container, "Confirm remove?")); });
        expect(onCommand).toHaveBeenLastCalledWith(["package", "remove", "npm:@acme/ext", "--local"]);

        await act(async () => { fireEvent.click(button(container, "Update all")); });
        expect(onCommand).toHaveBeenLastCalledWith(["package", "update"]);

        const input = container.querySelector('input[aria-label="Pi package source"]') as HTMLInputElement;
        const project = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(project.parentElement?.textContent).toBe("Project (repo)");
        await act(async () => {
            fireEvent.click(project);
            fireEvent.change(input, { target: { value: "git:github.com/a/b" } });
            fireEvent.submit(input.closest("form")!);
        });
        expect(onCommand).toHaveBeenLastCalledWith(["package", "install", "git:github.com/a/b", "--local"]);
    });

    test("pi packages collapse into an accordion alongside plugins", () => {
        const { container, queryByText } = render(<PluginsView data={data} />);
        const toggle = [...container.querySelectorAll("h4 button")].find((b) => b.textContent?.includes("Pi packages")) as HTMLButtonElement;
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        expect(queryByText("npm:@acme/ext")).toBeNull();
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(queryByText("npm:@acme/ext")).toBeTruthy();
    });

    test("loading shows a status line and blocks the stale view", () => {
        const { getByText, container } = render(<PluginsView data={data} loading />);
        expect(getByText("Loading from runner…").getAttribute("role")).toBe("status");
        expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    });

    test("toPluginsViewData tolerates legacy and malformed payloads", () => {
        expect(toPluginsViewData({ kind: "plugins", plugins: [] }).overview).toEqual({ plugins: [], disabled: [], marketplaces: [], packages: [], packagesCwd: undefined });
        expect(toPluginsViewData(null).isError).toBe(false);
        expect(toPluginsViewData({ overview: { plugins: "nope" }, isError: true }).overview.plugins).toEqual([]);
        const [p] = toPluginsViewData({ overview: { plugins: [{ name: "x", commands: [{ name: "c" }] }] } }).overview.plugins;
        expect(p.rules).toEqual([]);
        expect(p.commands).toEqual([{ name: "c" }]);
    });
});
