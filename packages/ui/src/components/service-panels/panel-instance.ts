/**
 * Dock panel ids may carry an instance suffix so one service can occupy several
 * dock tabs: `"tunnel"` (the service panel) vs `"tunnel#3000"` (a single tunnel
 * detached into its own tab). Everything downstream — positions, drag zones,
 * close handlers — already keys off the opaque panel id, so the only thing that
 * needs to know about the suffix is registry lookup.
 */
export function parsePanelId(panelId: string): { serviceId: string; instance?: string } {
    const i = panelId.indexOf("#");
    if (i === -1) return { serviceId: panelId };
    const instance = panelId.slice(i + 1);
    return { serviceId: panelId.slice(0, i), instance: instance || undefined };
}

export function makePanelId(serviceId: string, instance: string | number): string {
    return `${serviceId}#${instance}`;
}
