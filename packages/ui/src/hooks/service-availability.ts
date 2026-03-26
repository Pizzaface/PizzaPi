/**
 * Pure utility — checks if a service ID is present in the socket's cached
 * service_announce payload.  Zero React dependencies so it can be tested
 * without mocking any module.
 */

const SERVICE_IDS_KEY = "__serviceIds" as const;

export function getEagerServiceAvailability(socket: unknown, serviceId: string): boolean {
    const ids = socket && typeof socket === "object"
        ? ((socket as Record<string, unknown>)[SERVICE_IDS_KEY] as string[] | undefined)
        : undefined;
    return Array.isArray(ids) && ids.includes(serviceId);
}
