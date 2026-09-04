/**
 * Dock panel ids may carry an instance suffix and/or a runner scope so one
 * service can occupy several dock tabs: `"tunnel"` (the service panel),
 * `"tunnel#3000"` (a single tunnel detached into its own tab), and
 * `"tunnel#3000@runner-1"` / `"tunnel@runner-1"` (pinned to a specific runner —
 * traveling panels keep their runner across session switches). Everything
 * downstream — positions, drag zones, close handlers — already keys off the
 * opaque panel id, so the only thing that needs to know about the suffixes is
 * registry lookup.
 */
export interface ParsedPanelId {
    serviceId: string;
    instance?: string;
    /** Runner the panel is pinned to (`tunnel@r1`) — absent = unscoped. */
    runnerId?: string;
}

export function parsePanelId(panelId: string): ParsedPanelId {
    // The runner scope is always the last component (`tunnel@r1`,
    // `tunnel#3000@r1`), so split it off first, then the instance suffix.
    const [base, runnerPart] = splitOnce(panelId, "@");
    const [serviceId, instancePart] = splitOnce(base, "#");
    return { serviceId, instance: instancePart || undefined, runnerId: runnerPart ? decodePanelPart(runnerPart) : undefined };
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
    const i = value.indexOf(sep);
    if (i === -1) return [value, undefined];
    return [value.slice(0, i), value.slice(i + sep.length)];
}

function decodePanelPart(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function makePanelId(serviceId: string, instance: string | number): string {
    return `${serviceId}#${instance}`;
}

/** Panel id pinned to a runner — `tunnel@r1` or `tunnel#3000@r1`. */
export function scopePanelIdToRunner(panelId: string, runnerId: string | null | undefined): string {
    if (!runnerId) return panelId;
    return `${panelId}@${encodeURIComponent(runnerId)}`;
}

/** Strip the runner scope off a panel id (`tunnel#3000@r1` → `tunnel#3000`). */
export function unscopePanelId(panelId: string): string {
    const [head] = splitOnce(panelId, "@");
    return head;
}
